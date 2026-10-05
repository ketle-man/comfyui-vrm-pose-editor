// image_pose_solver.js — 画像 → VRM ポーズ（SAM 3D Body の出力 GLB から VRM Humanoid の正規化ボーン回転を解く）
// プロトタイプ(vrm1: src/solver.ts / src/sam3d.ts)からの移植。MediaPipe には依存せず、SAM3D の出力だけで解く。
//
// ・SAM3D の本体コード・モデル重みはこのリポジトリに含めない。ComfyUI のネイティブノードが出力した GLB
//   (BuildPoseFile → SaveGLB) をバイト列として受け取り、node 名と姿勢だけを読む。
// ・ソルバーは VRM 1.0 規約(モデルは +Z 向き、モデルの左手が +X、上が +Y)の空間で回転を計算する。
//   VRM 0.x の正規化ボーンは -Z 向き空間なので、適用時に四元数の x,z を反転する(applySolvedPose)。

import * as THREE from './vendor/three.module.js';

// ================================================================
// SAM3D の GLB 解析
// ================================================================

// OpenPose-18 の名前 → MediaPipe Pose のランドマーク番号(本人の左右)。ソルバーは MediaPipe の並びで受け取る
const NAME_TO_MP = {
    Nose: 0, LEye: 2, REye: 5, LEar: 7, REar: 8,
    LShoulder: 11, RShoulder: 12, LElbow: 13, RElbow: 14, LWrist: 15, RWrist: 16,
    LHip: 23, RHip: 24, LKnee: 25, RKnee: 26, LAnkle: 27, RAnkle: 28,
};

function readGlbJson(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error("GLB ではありません");
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
}

// SAM3D の GLB の種類: openpose = 骨名つき 3D 位置(解く用)、mesh = スキニング済み人体メッシュ(手の形を読む用)
export function classifyGlb(buf) {
    let json;
    try { json = readGlbJson(buf); } catch { return "unknown"; }
    if (json.nodes?.some(n => /^openpose_[A-Za-z]+$/.test(n.name ?? ""))) return "openpose";
    if (json.skins?.length && json.meshes?.length) return "mesh";
    return "unknown";
}

// GLB の node 名 `openpose_*`(マーカー球)の位置を 名前 → [x, y, z] で返す
export function parseOpenposeGlb(buf) {
    const json = readGlbJson(buf);
    const out = new Map();
    for (const n of json.nodes ?? []) {
        const m = /^openpose_([A-Za-z]+)$/.exec(n.name ?? "");
        if (m && n.translation?.length === 3) out.set(m[1], n.translation);
    }
    if (!out.has("LHip") || !out.has("RHip") || !out.has("LShoulder") || !out.has("RShoulder")) {
        throw new Error("openpose 形式の GLB ではありません(BuildPoseFile で format=glb, mesh_style=openpose にしてください)");
    }
    return out;
}

// SAM3D の 3D 位置から、ソルバー入力(MediaPipe ワールドランドマーク 33 点の並び)を作る。
// SAM3D は Y 上・手前が +Z・メートル、MediaPipe ワールドは Y 下・奥が +Z・腰中心のメートル。
// SAM3D に無い点(指先・かかと・つま先等)は visibility 0 にしておき、ソルバー側で使わない。
export function samToPose(sam, hands) {
    const lh = sam.get("LHip"), rh = sam.get("RHip");
    const hipMid = [0, 1, 2].map(i => (lh[i] + rh[i]) / 2);
    const out = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
    for (const [name, i] of Object.entries(NAME_TO_MP)) {
        const p = sam.get(name);
        if (p) out[i] = { x: p[0] - hipMid[0], y: -(p[1] - hipMid[1]), z: -(p[2] - hipMid[2]), visibility: 1 };
    }
    // 手の形(body_mesh)があれば、人差し指・小指の付け根を手首からの相対位置で補う(手の向きの補助)
    const fill = (handPts, iWr, iIdx, iPk) => {
        if (!handPts || !out[iWr].visibility) return;
        const w = handPts[0];
        const rel = (p) => ({ x: out[iWr].x + (p.x - w.x), y: out[iWr].y + (p.y - w.y), z: out[iWr].z + (p.z - w.z), visibility: 1 });
        out[iIdx] = rel(handPts[5]);
        out[iPk] = rel(handPts[17]);
    };
    fill(hands?.left, 15, 19, 17);
    fill(hands?.right, 16, 20, 18);
    return out;
}

// body_mesh の GLB(MHR 骨格)の姿勢から、両手の指まで含む MediaPipe Hand 形式の 21 点を作る。
// 骨名は bone_NNN のみなので MHR の並びで対応づける(右手首 = bone_042、左手首 = bone_078)。
// ノードの回転・位置にポーズが焼き込まれている。座標は MediaPipe ワールド(y, z を反転)にして返す。
export function parseMeshHands(buf) {
    const json = readGlbJson(buf);
    const nodes = json.nodes ?? [];
    const byName = new Map();
    nodes.forEach((n, i) => { if (n.name) byName.set(n.name, i); });
    const root = nodes.findIndex(n => n.name === "bone_000");
    if (root < 0) return {};

    // ワールド位置・回転(スケールは 1 前提)を順に求める
    const pos = new Map();
    const quat = new Map();
    const walk = (i, pq, pp) => {
        const n = nodes[i];
        const q = n.rotation ?? [0, 0, 0, 1];
        const r = rotate(pq, n.translation ?? [0, 0, 0]);
        const p = [pp[0] + r[0], pp[1] + r[1], pp[2] + r[2]];
        pos.set(i, p);
        const wq = qmul(pq, q);
        quat.set(i, wq);
        for (const c of n.children ?? []) walk(c, wq, p);
    };
    walk(root, [0, 0, 0, 1], [0, 0, 0]);

    const idxOf = (k) => byName.get(`bone_${String(k).padStart(3, "0")}`);
    const bone = (k) => {
        const i = idxOf(k);
        const p = i === undefined ? undefined : pos.get(i);
        return p ? { x: p[0], y: -p[1], z: -p[2] } : null;
    };
    // MediaPipe Hand の 0..20 に対応する MHR 骨(右手。左手は +36)。
    // 小指 043〜047(043 は中手骨)、薬指 048〜051、中指 052〜055、人差し指 056〜059、
    // 親指 060〜064(060 はウェイト 0 の補助骨、061 が中手骨)。各指の最後の骨の始点を指先として使う
    const MAP = [42, 61, 62, 63, 64, 56, 57, 58, 59, 52, 53, 54, 55, 48, 49, 50, 51, 44, 45, 46, 47];
    const build = (off) => {
        const pts = MAP.map(k => bone(k + off));
        return pts.every(p => p) ? pts : undefined;
    };
    // 手首の骨のローカル Z 軸(指を曲げる軸と揃う)。手のひらが丸まっていても手の向きがずれない
    const sideOf = (k) => {
        const i = idxOf(k);
        const q = i === undefined ? undefined : quat.get(i);
        if (!q) return undefined;
        const z = rotate(q, [0, 0, 1]);
        return { x: z[0], y: -z[1], z: -z[2] };
    };
    return { right: build(0), left: build(36), rightSide: sideOf(42), leftSide: sideOf(78) };
}

function qmul(a, b) {
    const [x1, y1, z1, w1] = a;
    const [x2, y2, z2, w2] = b;
    return [
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    ];
}
function rotate(q, v) {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
    ];
}

// ================================================================
// ソルバー: 3D ランドマーク → VRM Humanoid 正規化ボーンのローカル回転
// ================================================================
// 正規化ボーンはレスト時に回転が単位なので、ボーンの「ワールド回転」を求めてから
// 親のワールド回転の逆を掛ければローカル回転になる。

export const defaultSolveOptions = {
    headPitchDeg: 15,   // 鼻が耳より下にあることによる頭のうつむき誤差の補正(度)
    removeYaw: false,   // 体全体のヨー(カメラに対する向き)を除去して正面向きにする
    fingers: true,      // 指を解く
    twistSplit: 0.5,    // 手首のねじれを前腕に分配する割合 0..1
    minVisibility: 0.3, // 見えていないとみなす visibility の閾値
    mirror: false,      // 画像が鏡像(自撮り等)の場合に左右を入れ替える
};

// MediaPipe Pose のランドマーク番号(左右は「本人の」左右)
const P = {
    nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
    lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lHip: 23, rHip: 24,
    lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
};

const MIRROR_PAIRS = [
    [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20],
    [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];

// 指: [ボーン名(接尾), MediaPipe Hand のランドマーク列]
const FINGERS = [
    { bones: ["ThumbMetacarpal", "ThumbProximal", "ThumbDistal"], lm: [1, 2, 3, 4] },
    { bones: ["IndexProximal", "IndexIntermediate", "IndexDistal"], lm: [5, 6, 7, 8] },
    { bones: ["MiddleProximal", "MiddleIntermediate", "MiddleDistal"], lm: [9, 10, 11, 12] },
    { bones: ["RingProximal", "RingIntermediate", "RingDistal"], lm: [13, 14, 15, 16] },
    { bones: ["LittleProximal", "LittleIntermediate", "LittleDistal"], lm: [17, 18, 19, 20] },
];

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
// T ポーズ(VRM 正規化リグ)での手のひらの向き
const PALM_REST = new THREE.Vector3(0, -1, 0);

// MediaPipe 座標 (x右, y下, z奥) → VRM1 規約 (カメラ手前が +Z)
function toV(p) { return new THREE.Vector3(p.x, -p.y, -p.z); }

// 主軸 p と副軸 s から正規直交フレームの回転を作る
function frameQuat(p, s) {
    const x = p.clone().normalize();
    const z = s.clone().sub(x.clone().multiplyScalar(s.dot(x))).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

// レストのフレーム (restP, restS) をターゲットのフレーム (tgtP, tgtS) に重ねるワールド回転
function alignFrames(restP, restS, tgtP, tgtS) {
    return frameQuat(tgtP, tgtS).multiply(frameQuat(restP, restS).invert());
}

// v から軸 axis 方向の成分を除いた単位ベクトル
function proj0(axis, v) {
    return v.clone().sub(axis.clone().multiplyScalar(v.dot(axis))).normalize();
}

// 親の回転に追従した上で、ボーン軸 restDir を target に向ける最小回転(スイング)を加えたワールド回転
function swing(parentWorld, restDir, target) {
    const cur = restDir.clone().applyQuaternion(parentWorld).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(cur, target.clone().normalize());
    return q.multiply(parentWorld);
}

// 曲げ量 sin(θ) → ねじれを曲げ方向に合わせる重み(約 7° 未満で 0、約 25° 以上で 1)
function bendWeight(sinBend) {
    return THREE.MathUtils.smoothstep(sinBend, 0.12, 0.42);
}

// 2 セグメントの関節(肩-肘-手首、股-膝-足首)の根元ボーンのワールド回転。
// 曲げ方向(中間関節から先の、根元軸に垂直な成分)を使ってねじれまで決める。
// 小さい曲げでは曲げ方向がノイズなので、曲げ量に応じてスイングのみの回転と滑らかに混ぜる
function limbRoot(parentWorld, restAxis, restBend, a, b, c) {
    const axis = b.clone().sub(a);
    const next = c.clone().sub(b);
    const n = axis.clone().normalize();
    const perp = next.clone().sub(n.multiplyScalar(next.dot(n)));
    const qs = swing(parentWorld, restAxis, axis);
    const t = bendWeight(perp.length() / Math.max(next.length(), 1e-6));
    if (t <= 0) return qs;
    return qs.slerp(alignFrames(restAxis, restBend, axis, perp), t);
}

const sub = (a, b) => a.clone().sub(b);
const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);
const localOf = (parentWorld, world) => parentWorld.clone().invert().multiply(world);
// 単位回転から q への割合 t の回転
const frac = (q, t) => new THREE.Quaternion().slerp(q, t);

// q の軸 axis まわりのツイスト成分
function twistAbout(q, axis) {
    const v = new THREE.Vector3(q.x, q.y, q.z);
    const p = axis.clone().multiplyScalar(v.dot(axis));
    const t = new THREE.Quaternion(p.x, p.y, p.z, q.w);
    if (t.lengthSq() < 1e-12) return new THREE.Quaternion();
    return t.normalize();
}

function mirrorInput(input) {
    const pose = input.pose.map(p => ({ ...p, x: -p.x }));
    for (const [a, b] of MIRROR_PAIRS) [pose[a], pose[b]] = [pose[b], pose[a]];
    const flip = h => h?.map(p => ({ ...p, x: -p.x }));
    const flipP = p => p && { ...p, x: -p.x };
    return {
        pose, leftHand: flip(input.rightHand), rightHand: flip(input.leftHand),
        leftHandSide: flipP(input.rightHandSide), rightHandSide: flipP(input.leftHandSide),
    };
}

// input: { pose: Point3[33], leftHand?, rightHand?, leftHandSide?, rightHandSide? }
// rig:   { rest: Map<boneName, THREE.Vector3> }(VRM1 規約のレスト位置)
// 戻り値: { rotations: Map<boneName, THREE.Quaternion>(VRM1 規約のローカル回転), skipped: string[] }
export function solvePose(rawInput, rig, opt) {
    const input = opt.mirror ? mirrorInput(rawInput) : rawInput;
    const rot = new Map();
    const skipped = [];
    const L = input.pose.map(toV);
    const visible = (...idx) => idx.every(i => (input.pose[i].visibility ?? 1) >= opt.minVisibility);
    const has = b => rig.rest.has(b);
    // レスト時のボーン方向 from→to。どちらかが無ければ fallback
    const restDir = (from, to, fallback) => {
        const a = rig.rest.get(from);
        const b = rig.rest.get(to);
        if (!a || !b) return fallback.clone();
        const d = sub(b, a);
        return d.lengthSq() < 1e-10 ? fallback.clone() : d.normalize();
    };

    // ---- 胴体 ----
    const midHip = mid(L[P.lHip], L[P.rHip]);
    const midSh = mid(L[P.lSh], L[P.rSh]);
    const torsoUp = sub(midSh, midHip);
    let hipsW = alignFrames(X, Y, sub(L[P.lHip], L[P.rHip]), torsoUp);
    // 胸は背骨の方向を優先して合わせ、肩のラインとの残差は鎖骨(shoulder ボーン)で吸収する
    const shoulderLine = sub(L[P.lSh], L[P.rSh]);
    const chestWRaw = alignFrames(Y, X, torsoUp, shoulderLine);

    let yawFix = new THREE.Quaternion();
    if (opt.removeYaw) {
        const f = Z.clone().applyQuaternion(hipsW);
        yawFix = new THREE.Quaternion().setFromAxisAngle(Y, -Math.atan2(f.x, f.z));
    }
    hipsW = yawFix.clone().multiply(hipsW);
    // 脚が見えないときは腰の傾きの根拠が無いので、向き(ヨー)だけ残して直立させる
    if (!visible(P.lKnee) && !visible(P.rKnee)) hipsW = twistAbout(hipsW, Y);
    const chestW = yawFix.clone().multiply(chestWRaw);
    rot.set("hips", hipsW.clone());

    // 背骨は存在するボーン数で均等に分配(同軸回転なので積が元の回転に一致する)
    const spineBones = ["spine", "chest", "upperChest"].filter(has);
    const spineRel = localOf(hipsW, chestW);
    const spinePart = frac(spineRel, 1 / Math.max(spineBones.length, 1));
    for (const b of spineBones) rot.set(b, spinePart.clone());
    const topW = spineBones.length ? chestW : hipsW;
    // 鎖骨の回転 = 胸の左右軸を実際の肩のラインへ向ける最小回転(左右共通、可動域 ±30°)
    let clavicleW = topW.clone();
    if (has("leftShoulder") || has("rightShoulder")) {
        const chestX = X.clone().applyQuaternion(topW);
        const line = shoulderLine.clone().applyQuaternion(yawFix).normalize();
        let r = new THREE.Quaternion().setFromUnitVectors(chestX, line);
        const ang = 2 * Math.acos(Math.min(1, Math.abs(r.w)));
        const maxAng = THREE.MathUtils.degToRad(30);
        if (ang > maxAng) r = frac(r, maxAng / ang);
        clavicleW = r.multiply(topW);
    }

    // ---- 首・頭 ----
    if (visible(P.nose, P.lEar, P.rEar)) {
        const midEar = mid(L[P.lEar], L[P.rEar]);
        const headW = yawFix.clone()
            .multiply(alignFrames(X, Z, sub(L[P.lEar], L[P.rEar]), sub(L[P.nose], midEar)))
            .multiply(new THREE.Quaternion().setFromAxisAngle(X, -THREE.MathUtils.degToRad(opt.headPitchDeg)));
        const rel = localOf(topW, headW);
        if (has("neck")) {
            rot.set("neck", frac(rel, 0.5));
            rot.set("head", frac(rel, 0.5));
        } else {
            rot.set("head", rel);
        }
    } else {
        skipped.push("head");
    }

    // ---- 腕 ----
    for (const side of ["left", "right"]) {
        const s = side === "left";
        const [iSh, iEl, iWr, iIdx, iPk] = s
            ? [P.lSh, P.lEl, P.lWr, P.lIndex, P.lPinky]
            : [P.rSh, P.rEl, P.rWr, P.rIndex, P.rPinky];
        if (!visible(iEl, iWr)) { skipped.push(`${side}Arm`); continue; }
        const sign = s ? 1 : -1;
        const tf = v => v.clone().applyQuaternion(yawFix);
        const [pSh, pEl, pWr] = [tf(L[iSh]), tf(L[iEl]), tf(L[iWr])];

        const upperAxis = restDir(`${side}UpperArm`, `${side}LowerArm`, X.clone().multiplyScalar(sign));
        const lowerAxis = restDir(`${side}LowerArm`, `${side}Hand`, X.clone().multiplyScalar(sign));
        // 上腕の親は鎖骨(無いモデルでは胸)
        const armParentW = has(`${side}Shoulder`) ? clavicleW : topW;
        const upperW = limbRoot(armParentW, upperAxis, Z, pSh, pEl, pWr);
        let lowerW = swing(upperW, lowerAxis, sub(pWr, pEl));

        // 手のフレーム: 主軸 = 手首→中指付け根, 副軸 = 小指側→人差し指側
        const handAxis = restDir(`${side}Hand`, `${side}MiddleProximal`, X.clone().multiplyScalar(sign));
        const handSide = restDir(`${side}LittleProximal`, `${side}IndexProximal`, Z);
        const hand = s ? input.leftHand : input.rightHand;
        let handW;
        let hl = null;
        if (hand) {
            hl = hand.map(p => tf(toV(p)));
            const sideT = sub(hl[5], hl[17]);
            const sideIn = s ? input.leftHandSide : input.rightHandSide;
            if (sideIn) {
                const g = tf(toV(sideIn));
                if (g.dot(sideT) < 0) g.negate();
                sideT.copy(g);
            }
            handW = alignFrames(handAxis, handSide, sub(hl[9], hl[0]), sideT);
        } else if (visible(iIdx, iPk)) {
            const [pIdx, pPk] = [tf(L[iIdx]), tf(L[iPk])];
            handW = alignFrames(handAxis, handSide, sub(mid(pIdx, pPk), pWr), sub(pIdx, pPk));
        } else {
            handW = lowerW.clone();
        }

        // 手首のねじれの一部を前腕に移す(手首だけが極端にねじれて見えるのを防ぐ)
        let handLocal = localOf(lowerW, handW);
        if (opt.twistSplit > 0) {
            const tw = frac(twistAbout(handLocal, lowerAxis), opt.twistSplit);
            lowerW = lowerW.clone().multiply(tw);
            handLocal = tw.clone().invert().multiply(handLocal);
        }

        if (has(`${side}Shoulder`)) rot.set(`${side}Shoulder`, localOf(topW, clavicleW));
        rot.set(`${side}UpperArm`, localOf(armParentW, upperW));
        rot.set(`${side}LowerArm`, localOf(upperW, lowerW));
        rot.set(`${side}Hand`, handLocal);

        // ---- 指 ----
        if (opt.fingers && hl) {
            for (const f of FINGERS) {
                let parentW = handW;
                for (let k = 0; k < 3; k++) {
                    const bone = `${side}${f.bones[k]}`;
                    if (!has(bone)) break;
                    const fallback = k > 0
                        ? restDir(`${side}${f.bones[k - 1]}`, bone, X.clone().multiplyScalar(sign))
                        : X.clone().multiplyScalar(sign);
                    const dir = k < 2 ? restDir(bone, `${side}${f.bones[k + 1]}`, fallback) : fallback;
                    const seg = sub(hl[f.lm[k + 1]], hl[f.lm[k]]);
                    let w;
                    if (f.bones[0] === "ThumbMetacarpal") {
                        w = swing(parentW, dir, seg);
                    } else if (k === 0) {
                        // 付け根: 手のひらの面内で開いてから、開いた後の横軸まわりに曲げる(ねじれを作らない)
                        const cur = dir.clone().applyQuaternion(parentW).normalize();
                        const lat = proj0(dir, handSide).applyQuaternion(parentW).normalize();
                        const palmN = new THREE.Vector3().crossVectors(lat, cur).normalize();
                        const t = seg.clone().normalize();
                        const inPalm = t.clone().sub(palmN.clone().multiplyScalar(t.dot(palmN)));
                        // 90° を超えて曲げた指は手のひら面への射影が逆向きになるので反転し、開きは ±35° に制限する
                        if (inPalm.dot(cur) < 0) inPalm.negate();
                        let qAbd = new THREE.Quaternion();
                        if (inPalm.lengthSq() > 1e-8) {
                            const abd = Math.atan2(new THREE.Vector3().crossVectors(cur, inPalm.normalize()).dot(palmN), cur.dot(inPalm));
                            qAbd = new THREE.Quaternion().setFromAxisAngle(palmN, THREE.MathUtils.clamp(abd, -0.61, 0.61));
                        }
                        const qFlex = new THREE.Quaternion().setFromUnitVectors(cur.clone().applyQuaternion(qAbd), t);
                        w = qFlex.multiply(qAbd).multiply(parentW);
                    } else {
                        // 第2・第3関節は蝶番: 親の骨の横軸まわりの曲げだけにし、反り返りと曲げ過ぎは制限する
                        const axis = proj0(dir, handSide).applyQuaternion(parentW).normalize();
                        const cur = dir.clone().applyQuaternion(parentW).normalize();
                        const tgt = seg.clone().sub(axis.clone().multiplyScalar(seg.dot(axis)));
                        let ang = 0;
                        if (tgt.lengthSq() > 1e-12) {
                            tgt.normalize();
                            ang = Math.atan2(new THREE.Vector3().crossVectors(cur, tgt).dot(axis), cur.dot(tgt));
                        }
                        // 手のひら側へ回る向きを正にそろえてから制限する(-15°〜120°)
                        const palm = PALM_REST.clone().applyQuaternion(parentW);
                        const flexSign = new THREE.Vector3().crossVectors(axis, cur).dot(palm) >= 0 ? 1 : -1;
                        const flex = THREE.MathUtils.clamp(ang * flexSign, -Math.PI / 12, (Math.PI * 2) / 3);
                        w = new THREE.Quaternion().setFromAxisAngle(axis, flex * flexSign).multiply(parentW);
                    }
                    rot.set(bone, localOf(parentW, w));
                    parentW = w;
                }
            }
        } else if (opt.fingers && !hl) {
            skipped.push(`${side}Fingers`);
        }
    }

    // ---- 脚 ----
    for (const side of ["left", "right"]) {
        const s = side === "left";
        const [iHip, iKnee, iAnk, iHeel, iToe] = s
            ? [P.lHip, P.lKnee, P.lAnk, P.lHeel, P.lToe]
            : [P.rHip, P.rKnee, P.rAnk, P.rHeel, P.rToe];
        if (!visible(iKnee, iAnk)) { skipped.push(`${side}Leg`); continue; }
        const tf = v => v.clone().applyQuaternion(yawFix);
        const [pHip, pKnee, pAnk] = [tf(L[iHip]), tf(L[iKnee]), tf(L[iAnk])];
        const down = new THREE.Vector3(0, -1, 0);
        const upperAxis = restDir(`${side}UpperLeg`, `${side}LowerLeg`, down);
        const lowerAxis = restDir(`${side}LowerLeg`, `${side}Foot`, down);
        // 膝は曲げると下腿が後ろ(-Z)へ行く
        const upperW = limbRoot(hipsW, upperAxis, Z.clone().negate(), pHip, pKnee, pAnk);
        const lowerW = swing(upperW, lowerAxis, sub(pAnk, pKnee));
        rot.set(`${side}UpperLeg`, localOf(hipsW, upperW));
        rot.set(`${side}LowerLeg`, localOf(upperW, lowerW));
        if (visible(iHeel, iToe)) {
            const footAxis = restDir(`${side}Foot`, `${side}Toes`, new THREE.Vector3(0, -0.3, 1).normalize());
            const footW = swing(lowerW, footAxis, sub(tf(L[iToe]), pAnk));
            rot.set(`${side}Foot`, localOf(lowerW, footW));
        }
    }

    return { rotations: rot, skipped };
}

// ================================================================
// VRM への適用
// ================================================================

const HUMAN_BONES = [
    "hips", "spine", "chest", "upperChest", "neck", "head",
    "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
    "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
    "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
    "leftThumbMetacarpal", "leftThumbProximal", "leftThumbDistal",
    "leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal",
    "leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal",
    "leftRingProximal", "leftRingIntermediate", "leftRingDistal",
    "leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal",
    "rightThumbMetacarpal", "rightThumbProximal", "rightThumbDistal",
    "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
    "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
    "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
    "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal",
];

// 接地に使うボーンと床からの高さ(null = レスト時の高さ)
const GROUND_POINTS = [
    ["leftFoot", null], ["rightFoot", null], ["leftToes", null], ["rightToes", null],
    ["leftLowerLeg", 0.06], ["rightLowerLeg", 0.06], ["hips", 0.1],
];

const isVrm0Of = vrm => vrm?.meta?.metaVersion === "0";
const flipQ = q => new THREE.Quaternion(-q.x, q.y, -q.z, q.w);
const flipV = v => new THREE.Vector3(-v.x, v.y, -v.z);

// 正規化リグのレスト情報(VRM1 規約、vrm.scene ローカル)。現在のポーズは一時的に退避して戻す
export function captureRig(vrm) {
    const humanoid = vrm.humanoid;
    const saved = humanoid.getNormalizedPose();
    humanoid.resetNormalizedPose();
    vrm.scene.updateMatrixWorld(true);
    const isVrm0 = isVrm0Of(vrm);
    const rest = new Map();
    for (const name of HUMAN_BONES) {
        const node = humanoid.getNormalizedBoneNode(name);
        if (!node) continue;
        const p = vrm.scene.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
        rest.set(name, isVrm0 ? flipV(p) : p);
    }
    const restHipsPos = humanoid.getNormalizedBoneNode("hips").position.clone();
    humanoid.setNormalizedPose(saved);
    humanoid.update();
    vrm.scene.updateMatrixWorld(true);
    return { rest, restHipsPos };
}

// 解いた回転(VRM1 規約)を editor 経由で VRM に適用する。
// 回転は editor.importPose(version 2 形式)で入れる(Humanoid 更新・SpringBone の落ち着かせを editor 側に任せる)。
// ground = true なら、最も低い接地点が床(レスト時の足の高さ)に触れるよう hips の高さを調整する。
export function applySolvedPose(editor, vrm, rig, rotations, ground) {
    const isVrm0 = isVrm0Of(vrm);
    const humanoid = vrm.humanoid;
    const hips = humanoid.getNormalizedBoneNode("hips");

    const bones = {};
    for (const name of HUMAN_BONES) {
        if (!humanoid.getNormalizedBoneNode(name)) continue;
        const q = rotations.get(name) ?? new THREE.Quaternion();
        const n = isVrm0 ? flipQ(q) : q;
        bones[name] = { qx: n.x, qy: n.y, qz: n.z, qw: n.w };
    }
    // 接地計算のため、先に回転をノードへ入れて高さを測る(最後に importPose で正式に適用)
    for (const [name, b] of Object.entries(bones)) {
        humanoid.getNormalizedBoneNode(name).quaternion.set(b.qx, b.qy, b.qz, b.qw);
    }
    hips.position.copy(rig.restHipsPos);
    if (ground) {
        vrm.scene.updateMatrixWorld(true);
        let lift = -Infinity;
        for (const [b, c] of GROUND_POINTS) {
            const node = humanoid.getNormalizedBoneNode(b);
            const restP = rig.rest.get(b);
            if (!node || !restP) continue;
            const y = vrm.scene.worldToLocal(node.getWorldPosition(new THREE.Vector3())).y;
            lift = Math.max(lift, (c ?? restP.y) - y);
        }
        if (Number.isFinite(lift)) hips.position.y += lift;
    }
    editor.importPose(JSON.stringify({ version: 2, vrmVersion: vrm.meta?.metaVersion ?? null, bones }));
}
