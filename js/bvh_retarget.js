// SAM3DBody(ComfyUI の BuildPoseFile → bvh 出力)の BVH を VRM ヒューマノイドのキーフレームへリターゲットする。
//
// この BVH は関節名が joint_NNN(MHR の関節番号、ルートだけ "Hips")で、OFFSET は各関節のローカル軸系の値。
// ゼロ回転はバインドポーズではないため、汎用の BVH ローダー/リターゲッターでは扱えない。
// 回転チャンネル(ZXY オイラー)を親から順に掛けると MHR の絶対ワールド回転 G(j,t) になるので、
//   D_j(t) = G(j,t) * inv(Gbind(j))        … バインドからのワールド空間の回転差分
//   W_b(t) = D_j(t) * C_b                   … VRM ボーンのワールド回転(C_b は VRM の T ポーズ→MHR バインドの最短回転)
//   local_b = inv(W_parent) * W_b           … 正規化ヒューマノイドのローカル回転
// として求める。出力は exportPose().bones と同じ {qx,qy,qz,qw}(VRM1 正準空間)。
import { MHR_BIND } from './mhr_bind_data.js';

// ---- クォータニオン [x,y,z,w] ----
const qMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qInv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qNorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qAxis = (ax, deg) => { const h = deg * Math.PI / 360, s = Math.sin(h); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(h)]; };
const qRotVec = (q, v) => {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const vNorm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
// from → to の最短回転
function qArc(from, to) {
    const a = vNorm(from), b = vNorm(to);
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    if (d < -0.999999) {
        const ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const c = vNorm([a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]]);
        return [c[0], c[1], c[2], 0];
    }
    return qNorm([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + d]);
}
const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// 回転行列(列ベクトル x,y,z の3本)→ クォータニオン
function qFromBasis(x, y, z) {
    const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
    return qNorm(q);
}
// 主ベクトル(t1→b1)を厳密に、副ベクトル(t2→b2)を主ベクトルに直交する成分で合わせる回転(ひねりまで合わせる)
function qFrameAlign(t1, t2, b1, b2) {
    const frame = (a, c) => {
        const x = vNorm(a);
        const cp = vDot(c, x);
        const y = vNorm([c[0] - x[0] * cp, c[1] - x[1] * cp, c[2] - x[2] * cp]);
        return [x, y, vCross(x, y)];
    };
    const T = frame(t1, t2), B = frame(b1, b2);
    // R = B * T^T の各列(T の基底ベクトル → B の基底ベクトル)
    const col = (e) => { // R * e (e は標準基底)
        let r = [0, 0, 0];
        for (let i = 0; i < 3; i++) { const k = vDot(T[i], e); r = [r[0] + B[i][0] * k, r[1] + B[i][1] * k, r[2] + B[i][2] * k]; }
        return r;
    };
    return qFromBasis(col([1, 0, 0]), col([0, 1, 0]), col([0, 0, 1]));
}
// BVH の Zrotation Xrotation Yrotation(度) → R = Rz * Rx * Ry
const eulerZXY = (zDeg, xDeg, yDeg) => qMul(qMul(qAxis([0, 0, 1], zDeg), qAxis([1, 0, 0], xDeg)), qAxis([0, 1, 0], yDeg));

// ---- BVH パーサ ----
export function parseBvh(text) {
    const [hier, motion] = text.split(/\bMOTION\b/);
    if (!motion) throw new Error('Not a BVH file (MOTION section not found).');
    const joints = [];
    const stack = [];
    let cur = null;
    for (const raw of hier.split(/\r?\n/)) {
        const s = raw.trim();
        let m;
        if ((m = /^(ROOT|JOINT)\s+(\S+)/.exec(s))) {
            const parent = stack.length ? stack[stack.length - 1] : -1;
            cur = { name: m[2], parent, channels: [], chOffset: 0, mhr: null, offset: [0, 0, 0] };
            joints.push(cur);
            stack.push(joints.length - 1);
            m = /^joint_(\d+)$/.exec(cur.name);
            cur.mhr = m ? parseInt(m[1], 10) : (parent < 0 ? 1 : null);
        } else if (s.startsWith('End Site')) {
            stack.push(-2);
        } else if (s.startsWith('OFFSET') && stack[stack.length - 1] >= 0) {
            joints[stack[stack.length - 1]].offset = s.split(/\s+/).slice(1, 4).map(Number);
        } else if ((m = /^CHANNELS\s+(\d+)\s+(.*)$/.exec(s))) {
            cur.channels = m[2].trim().split(/\s+/);
        } else if (s === '}') {
            stack.pop();
        }
    }
    let off = 0;
    for (const j of joints) { j.chOffset = off; off += j.channels.length; }
    const lines = motion.trim().split(/\r?\n/);
    const frames = parseInt(/Frames:\s*(\d+)/.exec(lines[0])[1], 10);
    const frameTime = parseFloat(/Frame Time:\s*([\d.eE+-]+)/.exec(lines[1])[1]);
    const data = [];
    for (let i = 0; i < frames; i++) data.push(lines[2 + i].trim().split(/\s+/).map(Number));
    return { joints, frames, frameTime, fps: 1 / frameTime, channelCount: off, data };
}

// ---- MHR → VRM 対応表 ----
// j: MHR 関節(そのワールド回転を使う) / to: ボーン方向を決める子関節(バインド上) / T: VRM の T ポーズでのボーン方向
// ref: ひねり(ボーン軸まわりの回転)も合わせたいボーンの第2ベクトル。{ from, to, T } = MHR バインド上の from→to の向きを
//      VRM の T ポーズでの向き T に合わせる(腕: 小指の付け根→人差し指の付け根 = T ポーズでは +Z=手のひらを下にして親指側が前)。
//      上腕・前腕・手の3つに同じ基準を使い、手首・肘で補正のひねりが溜まらないようにする
// VRM1 正準: +Z が正面、キャラクターの左が +X
const UP = [0, 1, 0], DOWN = [0, -1, 0], FWD = [0, 0, 1];
const LX = [1, 0, 0], RX = [-1, 0, 0];
export const VRM_BONE_MAP = {
    hips:          { j: 1,   to: null, T: UP, parent: null },
    spine:         { j: 34,  to: 36,   T: UP, parent: 'hips' },
    chest:         { j: 36,  to: 37,   T: UP, parent: 'spine' },
    upperChest:    { j: 37,  to: 110,  T: UP, parent: 'chest' },
    neck:          { j: 110, to: 113,  T: UP, parent: 'upperChest' },
    head:          { j: 113, to: 126,  T: UP, parent: 'neck' },
    leftShoulder:  { j: 74,  to: 75,   T: LX, parent: 'upperChest' },
    leftUpperArm:  { j: 75,  to: 76,   T: LX, parent: 'leftShoulder', ref: { from: 79, to: 92, T: FWD } },
    leftLowerArm:  { j: 76,  to: 77,   T: LX, parent: 'leftUpperArm', ref: { from: 79, to: 92, T: FWD } },
    leftHand:      { j: 78,  to: 88,   T: LX, parent: 'leftLowerArm', ref: { from: 79, to: 92, T: FWD } },
    rightShoulder: { j: 38,  to: 39,   T: RX, parent: 'upperChest' },
    rightUpperArm: { j: 39,  to: 40,   T: RX, parent: 'rightShoulder', ref: { from: 43, to: 56, T: FWD } },
    rightLowerArm: { j: 40,  to: 41,   T: RX, parent: 'rightUpperArm', ref: { from: 43, to: 56, T: FWD } },
    rightHand:     { j: 42,  to: 52,   T: RX, parent: 'rightLowerArm', ref: { from: 43, to: 56, T: FWD } },
    leftUpperLeg:  { j: 2,   to: 3,    T: DOWN, parent: 'hips' },
    leftLowerLeg:  { j: 3,   to: 4,    T: DOWN, parent: 'leftUpperLeg' },
    leftFoot:      { j: 4,   to: 7,    T: FWD, parent: 'leftLowerLeg' },
    leftToes:      { j: 7,   to: 8,    T: FWD, parent: 'leftFoot' },
    rightUpperLeg: { j: 18,  to: 19,   T: DOWN, parent: 'hips' },
    rightLowerLeg: { j: 19,  to: 20,   T: DOWN, parent: 'rightUpperLeg' },
    rightFoot:     { j: 20,  to: 23,   T: FWD, parent: 'rightLowerLeg' },
    rightToes:     { j: 23,  to: 24,   T: FWD, parent: 'rightFoot' },
};
// ---- 指 ----
// MHR の指は 4 関節(付け根 MCP→PIP→DIP→先端)が人差し指・中指・薬指、5 関節が小指(手首側の中手骨 CMC が先頭)と
// 親指(先頭は手首側の補助関節、次が CMC)。区間長(cm)で確認済み。VRM は Proximal/Intermediate/Distal の 3 骨
// (親指は Metacarpal/Proximal/Distal)。j は骨の始点の関節、to は骨の終点(次の関節)
const THUMB_T = vNorm([0.6, -0.3, 0.74]); // VRM T ポーズでの親指の向きの既定値。実モデルの値があれば restDirs で上書きされる
function addFingers(side, base, TX) {
    // base: 手首(hand)の MHR 関節番号の次の指の先頭(左 79 / 右 43)
    const pinky = base, ring = base + 5, middle = base + 9, index = base + 13, thumb = base + 17;
    const hand = `${side}Hand`;
    const chain = (finger, joints, names) => {
        names.forEach((n, i) => {
            VRM_BONE_MAP[`${side}${finger}${n}`] = {
                j: joints[i], to: joints[i + 1], T: TX,
                parent: i === 0 ? hand : `${side}${finger}${names[i - 1]}`,
            };
        });
    };
    const P3 = ['Proximal', 'Intermediate', 'Distal'];
    chain('Index', [index, index + 1, index + 2, index + 3], P3);
    chain('Middle', [middle, middle + 1, middle + 2, middle + 3], P3);
    chain('Ring', [ring, ring + 1, ring + 2, ring + 3], P3);
    chain('Little', [pinky + 1, pinky + 2, pinky + 3, pinky + 4], P3);
    chain('Thumb', [thumb + 1, thumb + 2, thumb + 3, thumb + 4], ['Metacarpal', 'Proximal', 'Distal']);
    VRM_BONE_MAP[`${side}ThumbMetacarpal`].T = side === 'left' ? THUMB_T : [-THUMB_T[0], THUMB_T[1], THUMB_T[2]];
    for (const n of ['Proximal', 'Distal']) VRM_BONE_MAP[`${side}Thumb${n}`].T = VRM_BONE_MAP[`${side}ThumbMetacarpal`].T;
}
addFingers('left', 79, LX);
addFingers('right', 43, RX);

const BONE_ORDER = Object.keys(VRM_BONE_MAP); // 親が先に並んでいる

// VRM の T ポーズ → MHR バインドの補正回転 C_b を作る。restDirs(ボーン名→VRM1 正準空間でのレスト方向)があれば T を上書きする
function buildCorrection(restDirs) {
const _C = {};
for (const [name, d0] of Object.entries(VRM_BONE_MAP)) {
    const d = restDirs?.[name] ? { ...d0, T: restDirs[name] } : d0;
    if (d.to == null) { _C[name] = [0, 0, 0, 1]; continue; }
    const bDir = vSub(MHR_BIND[d.to].p, MHR_BIND[d.j].p);
    _C[name] = d.ref ? qFrameAlign(d.T, d.ref.T, bDir, vSub(MHR_BIND[d.ref.to].p, MHR_BIND[d.ref.from].p))
                     : qArc(d.T, bDir);
}
return _C;
}
const _C0 = buildCorrection(null);

// ---- リターゲット本体 ----
// opts.availableBones: 読み込み中モデルが持つボーン名の Set(省略時は全ボーン)。upperChest 等が無い VRM では親を付け替える。
// opts.restDirs: ボーン名 → その VRM のレスト方向(VRM1 正準空間)。指など T ポーズでも向きがモデルごとに違うボーン用
// opts.rootYawDeg: 全体を Y 軸まわりに回す角度(度)。映像内で人物がカメラを向くとき VRM を +Z 向きにそろえる補正
// opts.hipsScale: Hips 移動量の倍率(VRM の腰高 / BVH 被写体の腰高)。省略時 1(メートル相当)
// opts.legRest: 脚ボーンのレスト時の親からのオフセット {leftUpperLeg:[x,y,z], ...}(VRM1 正準空間, メートル)。あれば接地補正をかける
// opts.groundSnap: [吸着する高さ, 補正が 0 になる高さ] メートル(既定 [0.15, 0.35])
// opts.flattenFeet: false で接地中の足の水平化を無効化(既定 true。接地補正が有効なときだけ働く)
// opts.groundFeet: false で接地補正を無効化(既定 true)。最初のフレームの姿勢に依らず足が床に着くよう、腰の高さを足の位置から合わせる
// opts.hipsMotion: false で Hips の移動を出力しない。配列 [x,y,z] で軸ごとの倍率(例 [1,1,0] = 奥行きを無視)
// 戻り値: { fps, duration, frames, keyframes:[{time, bones:{name:{qx,qy,qz,qw}}}], hips:[[x,y,z]...] (最初のフレーム基準の移動量[m]) }
// hips の移動量は keyframes[].bones.hips の px,py,pz(レストからの移動量[m])にも入る(exportVrma が腰の位置トラックにする)
export function retargetBvh(bvh, opts = {}) {
    const avail = opts.availableBones ?? null;
    const _C = opts.restDirs ? buildCorrection(opts.restDirs) : _C0;
    const yaw = qAxis([0, 1, 0], opts.rootYawDeg ?? 0);
    const hipsScale = opts.hipsScale ?? 1;
    const hm = opts.hipsMotion === false ? null : (Array.isArray(opts.hipsMotion) ? opts.hipsMotion : [1, 1, 1]);
    const has = (b) => !avail || avail.has(b);
    const parentOf = (b) => { // 存在するボーンまで親をさかのぼる
        let p = VRM_BONE_MAP[b].parent;
        while (p && !has(p)) p = VRM_BONE_MAP[p].parent;
        return p;
    };

    const joints = bvh.joints;
    const byMhr = new Map();
    joints.forEach((jt, i) => { if (jt.mhr != null) byMhr.set(jt.mhr, i); });
    const needed = BONE_ORDER.filter(has);
    for (const b of needed) {
        if (!byMhr.has(VRM_BONE_MAP[b].j)) throw new Error(`BVH is missing MHR joint ${VRM_BONE_MAP[b].j} (needed for ${b}). Is this a SAM3DBody BVH?`);
    }

    const keyframes = [];
    const hips = [];
    const legW = []; // フレームごとの脚チェーンのワールド回転(接地補正用)
    let p0 = null;
    const G = new Array(joints.length);
    for (let f = 0; f < bvh.frames; f++) {
        const row = bvh.data[f];
        for (let i = 0; i < joints.length; i++) {
            const jt = joints[i];
            const ch = jt.channels;
            const o = jt.chOffset + (ch.length - 3); // 末尾3つが回転(Z,X,Y の順)
            const r = eulerZXY(row[o], row[o + 1], row[o + 2]);
            G[i] = jt.parent >= 0 ? qMul(G[jt.parent], r) : r;
        }
        const W = {};
        const bones = {};
        for (const b of needed) {
            const d = VRM_BONE_MAP[b];
            const D = qMul(yaw, qMul(G[byMhr.get(d.j)], qInv(MHR_BIND[d.j].q)));
            W[b] = qNorm(qMul(D, _C[b]));
            const p = parentOf(b);
            const l = qNorm(p ? qMul(qInv(W[p]), W[b]) : W[b]);
            bones[b] = { qx: l[0], qy: l[1], qz: l[2], qw: l[3] };
        }
        keyframes.push({ time: f * bvh.frameTime, bones });
        legW.push(W);

        const rj = joints[0];
        const pos = [row[rj.chOffset], row[rj.chOffset + 1], row[rj.chOffset + 2]].map(v => v * 0.01); // cm → m
        if (!p0) p0 = pos;
        const dlt = qRotVec(yaw, [pos[0] - p0[0], pos[1] - p0[1], pos[2] - p0[2]]).map(v => v * hipsScale);
        hips.push(dlt);
        if (hm && bones.hips) Object.assign(bones.hips, { px: dlt[0] * hm[0], py: dlt[1] * hm[1], pz: dlt[2] * hm[2] });
    }
    if (hm && opts.legRest && opts.groundFeet !== false) {
        const heights = groundFeet(keyframes, hips, legW, opts.legRest, hm, opts.groundSnap);
        if (heights && opts.flattenFeet !== false) flattenFeet(keyframes, legW, heights, parentOf, has);
    }
    return { fps: bvh.fps, duration: (bvh.frames - 1) * bvh.frameTime, frames: bvh.frames, keyframes, hips };
}

// ---- 接地補正 ----
// 単眼動画から出る腰の高さは、最初のフレームを基準にした相対値(最初のフレームが開脚・しゃがみでも立ち姿の腰高になる)ため、
// 足がまとめて浮く/沈む。脚チェーンを VRM のレスト寸法で FK して足の最下点の高さを求め、
//   1) 全体オフセット: 最下点の下位 5% が床に着くように腰を上下する
//   2) フレームごと: 床から snap[0](15cm)以内は床に吸着、snap[1](35cm)まで補正を弱める(それ以上浮くジャンプは残す)。軽く平滑化
//      推定誤差で数 cm〜十数 cm 浮くことが多く、本当の跳躍(30cm 超)は少ないため広めに取る
// 横方向の足の滑りは補正しない(接地中の水平速度は中央値 0.1m/s 程度で小さい)
function groundFeet(keyframes, hips, legW, rest, hm, snap = [0.15, 0.35]) {
    const chains = [['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes'], ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']];
    if (!chains.every(c => rest[c[0]] && rest[c[1]] && rest[c[2]])) return;
    // 腰を原点にした足の最下点の高さ(y)。toes が無ければ foot のみ。chainIdx 指定でその脚だけ
    const lowest = (W, chainIdx = -1) => {
        let m = Infinity;
        for (const [ci, c] of chains.entries()) {
            if (chainIdx >= 0 && ci !== chainIdx) continue;
            let pos = [0, 0, 0];
            let parentRot = W.hips ?? [0, 0, 0, 1];
            for (const b of c) {
                if (!rest[b]) break;
                const off = qRotVec(parentRot, rest[b]);
                pos = [pos[0] + off[0], pos[1] + off[1], pos[2] + off[2]];
                if (b.endsWith('Foot') || b.endsWith('Toes')) m = Math.min(m, pos[1]);
                parentRot = W[b] ?? parentRot;
            }
        }
        return m;
    };
    const ID = {};
    for (const c of chains) for (const b of c) ID[b] = [0, 0, 0, 1];
    ID.hips = [0, 0, 0, 1];
    const restLow = lowest(ID); // レスト(立ち姿・足は床に接地)の最下点
    const restLowC = [lowest(ID, 0), lowest(ID, 1)];
    const n = keyframes.length;
    // 腰の高さ(レストの腰位置 + 移動量)を含む足の最下点の、レストからの高さ
    const h = keyframes.map((_, f) => hips[f][1] + lowest(legW[f]) - restLow);
    const sorted = [...h].sort((a, b) => a - b);
    const g = -sorted[Math.floor(0.05 * (n - 1))]; // 下位 5% が床に着くオフセット
    const raw = h.map(v => v + g);
    // 床から近いフレームは吸着、離れるほど補正を弱める
    const corr = raw.map(v => {
        const a = Math.abs(v);
        const w = a <= snap[0] ? 1 : a >= snap[1] ? 0 : 1 - (a - snap[0]) / (snap[1] - snap[0]);
        return -v * w;
    });
    // 3 点ガウス平滑(2 回)
    let c = corr;
    for (let k = 0; k < 2; k++) c = c.map((v, i) => 0.25 * (c[Math.max(0, i - 1)] + c[Math.min(n - 1, i + 1)]) + 0.5 * v);
    const heights = [[], []]; // 補正後の脚ごとの最下点の床からの高さ(足の水平化の接地判定用)
    for (let f = 0; f < n; f++) {
        const dy = g + c[f];
        for (let ci = 0; ci < 2; ci++) heights[ci].push(hips[f][1] + lowest(legW[f], ci) - restLowC[ci] + dy);
        hips[f][1] += dy;
        const hb = keyframes[f].bones.hips;
        if (hb && hb.py !== undefined) hb.py = hips[f][1] * hm[1];
    }
    return heights;
}

// ---- 足の水平化 ----
// SAM3DBody の足の向きは単眼では内外のロールが定まらず、広い立ち位置などで両足が 20° 前後傾く(床に平らに着いているのに)。
// MHR の足には左右方向の基準になる関節が無く(基準姿勢では足は平ら)、手のような 2 ベクトルの姿勢合わせでは直せないため、
// 接地中(床から 3cm 以内で全適用、10cm で 0)の足は、前方軸まわりに回して左右軸を水平にする。つま先(Toes)も同じ回転で追従。
function flattenFeet(keyframes, legW, heights, parentOf, has) {
    const sides = [['left', [1, 0, 0], 1], ['right', [-1, 0, 0], -1]];
    for (const [ci, [side, latAxis, sgn]] of sides.entries()) {
        const foot = side + 'Foot', toes = side + 'Toes';
        if (!has(foot)) continue;
        for (let f = 0; f < keyframes.length; f++) {
            const hgt = heights[ci][f];
            const w = hgt <= 0.03 ? 1 : hgt >= 0.10 ? 0 : 1 - (hgt - 0.03) / 0.07;
            if (w <= 0) continue;
            const W = legW[f];
            const fwd = qRotVec(W[foot], [0, 0, 1]);
            if (Math.abs(fwd[1]) > 0.9) continue; // つま先がほぼ真上/真下のときは向きが定まらない
            const lat = qRotVec(W[foot], latAxis);
            const latT = vNorm(vCross([0, 1, 0], fwd)).map(v => v * sgn);
            let d = qArc(lat, latT);
            // 補正角は ±40° に制限し、接地の度合いで弱める(軸角→スケール)
            const ang = 2 * Math.acos(Math.min(1, Math.abs(d[3])));
            if (ang < 1e-4) continue;
            const k = Math.min(1, (40 * Math.PI / 180) / ang) * w;
            const sinH = Math.sqrt(1 - d[3] * d[3]) || 1;
            const half = ang * k / 2, sgnW = d[3] < 0 ? -1 : 1;
            const ax = [d[0] / sinH * sgnW, d[1] / sinH * sgnW, d[2] / sinH * sgnW];
            const dq = [ax[0] * Math.sin(half), ax[1] * Math.sin(half), ax[2] * Math.sin(half), Math.cos(half)];
            W[foot] = qNorm(qMul(dq, W[foot]));
            if (W[toes]) W[toes] = qNorm(qMul(dq, W[toes]));
            // ローカル回転を更新(足 = 下腿の逆 * 足、つま先 = 足の逆 * つま先)
            const bones = keyframes[f].bones;
            const setLocal = (b) => {
                const p = parentOf(b);
                const l = qNorm(p ? qMul(qInv(W[p]), W[b]) : W[b]);
                bones[b] = { ...bones[b], qx: l[0], qy: l[1], qz: l[2], qw: l[3] };
            };
            setLocal(foot);
            if (W[toes]) setLocal(toes);
        }
    }
}

// VRM1 正準空間のキーフレームを VRM0 モデル用(exportVrma が x,z を反転して正準化する前提)に変換する
export function keyframesToVrm0(keyframes) {
    return keyframes.map(k => {
        const bones = {};
        for (const [n, q] of Object.entries(k.bones)) {
            bones[n] = { qx: -q.qx, qy: q.qy, qz: -q.qz, qw: q.qw };
            if (q.px !== undefined) Object.assign(bones[n], { px: -q.px, py: q.py, pz: -q.pz });
        }
        return { time: k.time, bones };
    });
}

// SAM3DBody の BVH テキスト → .vrma(ArrayBuffer)。読み込み中の VRM(editor)のボーン構成・VRM0/1 に合わせる。
// 戻した .vrma は importVrmaAsKeyframes(Light & Pose Editor のキーフレーム取り込み)にそのまま渡せる。
export async function bvhTextToVrmaBuffer(editor, text, opts = {}) {
    const poseJson = editor.exportPose();
    if (!poseJson) throw new Error('Load a VRM model before importing a BVH.');
    const availableBones = new Set(Object.keys(JSON.parse(poseJson).bones));
    const bvh = parseBvh(text);
    // Hips 移動量の倍率 = VRM のレスト腰高 / BVH 被写体の腰高(ルートの OFFSET の Y を cm→m)
    const restHips = editor.getVRM?.()?.humanoid?.normalizedRestPose?.hips?.position;
    const subjectHipsY = bvh.joints[0].offset[1] * 0.01;
    const hipsScale = restHips && subjectHipsY > 0.1 ? restHips[1] / subjectHipsY : 1;
    const restDirs = restFingerDirs(editor.getVRM?.());
    const legRest = restLegOffsets(editor.getVRM?.());
    const result = retargetBvh(bvh, { availableBones, hipsScale, restDirs, legRest, ...opts });
    const isVrm0 = editor.getVRM?.()?.meta?.metaVersion === '0';
    const kfs = isVrm0 ? keyframesToVrm0(result.keyframes) : result.keyframes;
    return editor.exportVrma(kfs);
}

// 指ボーンのレスト方向 = その子ボーンのローカル位置(正規化ボーンはレストで回転が単位なので親フレーム=ワールド)。
// 子が無い Distal は自身の親からのオフセット(中節と同じ向き)。VRM0 は X,Z を反転して VRM1 正準空間にそろえる
function restFingerDirs(vrm) {
    const hum = vrm?.humanoid;
    if (!hum) return null;
    const flip = vrm.meta?.metaVersion === '0';
    const dirs = {};
    for (const [name, d] of Object.entries(VRM_BONE_MAP)) {
        if (!/(Thumb|Index|Middle|Ring|Little)/.test(name)) continue;
        const node = hum.getNormalizedBoneNode(name);
        if (!node) continue;
        const child = Object.keys(VRM_BONE_MAP).find(n => VRM_BONE_MAP[n].parent === name && /(Thumb|Index|Middle|Ring|Little)/.test(n));
        const src = (child && hum.getNormalizedBoneNode(child)?.position) ?? node.position;
        const v = [flip ? -src.x : src.x, src.y, flip ? -src.z : src.z];
        if (Math.hypot(...v) > 1e-6) dirs[name] = vNorm(v);
    }
    return dirs;
}

// 脚ボーンのレスト時の親からのオフセット(VRM1 正準空間。VRM0 は X,Z 反転)。接地補正の FK 用
function restLegOffsets(vrm) {
    const hum = vrm?.humanoid;
    if (!hum) return null;
    const flip = vrm.meta?.metaVersion === '0';
    const out = {};
    for (const side of ['left', 'right']) {
        for (const b of ['UpperLeg', 'LowerLeg', 'Foot', 'Toes']) {
            const node = hum.getNormalizedBoneNode(side + b);
            if (!node) continue;
            const p = node.position;
            out[side + b] = [flip ? -p.x : p.x, p.y, flip ? -p.z : p.z];
        }
    }
    return out;
}
