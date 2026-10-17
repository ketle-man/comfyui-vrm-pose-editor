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
// BVH の回転チャンネル(度)。チャンネルの並び順に R = R1 * R2 * R3(例: Zrotation Xrotation Yrotation → Rz * Rx * Ry)
const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const eulerByOrder = (order, a, b, c) =>
    qMul(qMul(qAxis(AXES[order[0]], a), qAxis(AXES[order[1]], b)), qAxis(AXES[order[2]], c));
const rotOrder = (channels) => channels.slice(-3).map(n => n[0].toUpperCase());

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
            cur = { name: m[2], parent, channels: [], chOffset: 0, mhr: null, offset: [0, 0, 0], endOffset: null };
            joints.push(cur);
            stack.push(joints.length - 1);
            m = /^joint_(\d+)$/.exec(cur.name);
            cur.mhr = m ? parseInt(m[1], 10) : (parent < 0 ? 1 : null);
        } else if (s.startsWith('End Site')) {
            stack.push(-2);
        } else if (s.startsWith('OFFSET') && stack[stack.length - 1] === -2) {
            // End Site のオフセット(葉の骨の向き・長さ)。親関節に最初の1つだけ記録する
            const owner = stack[stack.length - 2];
            if (owner >= 0 && !joints[owner].endOffset) joints[owner].endOffset = s.split(/\s+/).slice(1, 4).map(Number);
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
    // 種類: SAM3DBody(ルート Hips + joint_NNN)か、名前つきの一般的な BVH(CMU/Daz など)か
    const kind = joints.length > 1 && joints.slice(1).every(j => /^joint_\d+$/.test(j.name)) ? 'sam3d' : 'named';
    return { joints, frames, frameTime, fps: 1 / frameTime, channelCount: off, data, kind };
}

// ヘッダだけを読んで BVH の概要を返す(ダイアログの表示用。全フレームのパースはしない)
export function peekBvh(text) {
    const frames = parseInt(/Frames:\s*(\d+)/.exec(text)?.[1] ?? '0', 10);
    const frameTime = parseFloat(/Frame Time:\s*([\d.eE+-]+)/.exec(text)?.[1] ?? '0');
    const names = [...text.slice(0, text.search(/\bMOTION\b/) >>> 0 || undefined).matchAll(/(?:ROOT|JOINT)\s+(\S+)/g)].map(m => m[1]);
    const kind = names.length > 1 && names.slice(1).every(n => /^joint_\d+$/.test(n)) ? 'sam3d' : 'named';
    return { kind, frames, fps: frameTime > 0 ? 1 / frameTime : 0, durationSec: frames * frameTime };
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
    if (bvh.kind === 'named') return retargetNamedBvh(bvh, opts);
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
    const frameIdx = selectFrames(bvh, opts);
    for (const f of frameIdx) {
        const row = bvh.data[f];
        for (let i = 0; i < joints.length; i++) {
            const jt = joints[i];
            const ch = jt.channels;
            const o = jt.chOffset + (ch.length - 3); // 末尾3つが回転(順序はチャンネル名から)
            const r = eulerByOrder(rotOrder(ch), row[o], row[o + 1], row[o + 2]);
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
        keyframes.push({ time: (f - frameIdx[0]) * bvh.frameTime, bones });
        legW.push(W);

        const rj = joints[0];
        const pos = [row[rj.chOffset], row[rj.chOffset + 1], row[rj.chOffset + 2]].map(v => v * 0.01); // cm → m
        if (!p0) p0 = pos;
        const dlt = qRotVec(yaw, [pos[0] - p0[0], pos[1] - p0[1], pos[2] - p0[2]]).map(v => v * hipsScale);
        hips.push(dlt);
        if (hm && bones.hips) Object.assign(bones.hips, { px: dlt[0] * hm[0], py: dlt[1] * hm[1], pz: dlt[2] * hm[2] });
    }
    postProcessFeet(keyframes, hips, legW, opts, hm, parentOf, has);
    return { fps: bvh.fps, duration: (frameIdx[frameIdx.length - 1] - frameIdx[0]) * bvh.frameTime, frames: keyframes.length, keyframes, hips };
}

// 取り込む範囲の選択: opts.startSec / durationSec(0 または未指定 = 最後まで)で切り出し、
// opts.maxFps(既定 30)を超えるフレームレートは等間隔に間引く(CMU の 120fps → 30fps など)。戻り値は元のフレーム番号の配列
function selectFrames(bvh, opts) {
    const ft = bvh.frameTime;
    const start = Math.min(bvh.frames - 1, Math.max(0, Math.round((opts.startSec ?? 0) / ft)));
    const dur = opts.durationSec ?? 0;
    const end = dur > 0 ? Math.min(bvh.frames, start + Math.max(1, Math.round(dur / ft))) : bvh.frames;
    const stride = Math.max(1, Math.round(bvh.fps / (opts.maxFps ?? 30)));
    const idx = [];
    for (let f = start; f < end; f += stride) idx.push(f);
    if (!idx.length) idx.push(start);
    return idx;
}

// 接地補正 → 足の水平化(骨格の種類に依らない共通の後処理)
function postProcessFeet(keyframes, hips, legW, opts, hm, parentOf, has, targetHeights = null) {
    if (hm && opts.legRest && opts.groundFeet !== false) {
        const heights = groundFeet(keyframes, hips, legW, opts.legRest, hm, opts.groundSnap, targetHeights, opts.restHipsY ?? null);
        if (heights && opts.flattenFeet !== false) {
            flattenFeet(keyframes, legW, heights, parentOf, has);
            // 足を水平にすると足裏の点が数 cm 動いて床に沈むことがあるため、正解の高さに合わせる場合はもう一度合わせ直す
            if (targetHeights) groundFeet(keyframes, hips, legW, opts.legRest, hm, opts.groundSnap, targetHeights, opts.restHipsY ?? null);
        }
    }
}

// ---- 名前つき骨格(CMU / Daz など。回転ゼロが T ポーズで各軸が世界座標にそろった標準的な BVH) ----
// 関節名 → VRM ボーン。r/l はキャラクターの右/左(正面 +Z のとき右が -X)。指は 2 関節(Distal は中節から合成)
const NAMED_BONES = {
    hips: 'hip', spine: 'abdomen', chest: 'chest', neck: 'neck', head: 'head',
    leftShoulder: 'lCollar', leftUpperArm: 'lShldr', leftLowerArm: 'lForeArm', leftHand: 'lHand',
    rightShoulder: 'rCollar', rightUpperArm: 'rShldr', rightLowerArm: 'rForeArm', rightHand: 'rHand',
    leftUpperLeg: 'lThigh', leftLowerLeg: 'lShin', leftFoot: 'lFoot',
    rightUpperLeg: 'rThigh', rightLowerLeg: 'rShin', rightFoot: 'rFoot',
};
// ボーンの向きを決める子(null = 補正なし)。'end:' は End Site の向き
const NAMED_TO = {
    hips: null, spine: 'chest', chest: 'neck', neck: 'head', head: null,
    leftShoulder: 'lShldr', leftUpperArm: 'lForeArm', leftLowerArm: 'lHand', leftHand: 'lMid1',
    rightShoulder: 'rShldr', rightUpperArm: 'rForeArm', rightLowerArm: 'rHand', rightHand: 'rMid1',
    leftUpperLeg: 'lShin', leftLowerLeg: 'lFoot', leftFoot: 'end:lFoot',
    rightUpperLeg: 'rShin', rightLowerLeg: 'rFoot', rightFoot: 'end:rFoot',
};
for (const [side, pre] of [['left', 'l'], ['right', 'r']]) {
    Object.assign(NAMED_BONES, {
        [`${side}ThumbProximal`]: `${pre}Thumb1`, [`${side}ThumbDistal`]: `${pre}Thumb2`,
        [`${side}IndexProximal`]: `${pre}Index1`, [`${side}IndexIntermediate`]: `${pre}Index2`,
        [`${side}MiddleProximal`]: `${pre}Mid1`, [`${side}MiddleIntermediate`]: `${pre}Mid2`,
        [`${side}RingProximal`]: `${pre}Ring1`, [`${side}RingIntermediate`]: `${pre}Ring2`,
        [`${side}LittleProximal`]: `${pre}Pinky1`, [`${side}LittleIntermediate`]: `${pre}Pinky2`,
    });
    Object.assign(NAMED_TO, {
        [`${side}ThumbProximal`]: `${pre}Thumb2`, [`${side}ThumbDistal`]: `end:${pre}Thumb2`,
        [`${side}IndexProximal`]: `${pre}Index2`, [`${side}IndexIntermediate`]: `end:${pre}Index2`,
        [`${side}MiddleProximal`]: `${pre}Mid2`, [`${side}MiddleIntermediate`]: `end:${pre}Mid2`,
        [`${side}RingProximal`]: `${pre}Ring2`, [`${side}RingIntermediate`]: `end:${pre}Ring2`,
        [`${side}LittleProximal`]: `${pre}Pinky2`, [`${side}LittleIntermediate`]: `end:${pre}Pinky2`,
    });
}
// この経路には upperChest が無い(neck と肩の親は chest)。親子関係は VRM_BONE_MAP と同じで、これだけ付け替える
const NAMED_PARENT = { neck: 'chest', leftShoulder: 'chest', rightShoulder: 'chest' };
// 指の先端(Distal)は中節の回転を 2/3 コピーして合成する(関節が 2 つしか無いため)
const FINGER_DISTAL_SYNTH = 0.66;

// 骨盤の幅の違いを脚の開きで補う。リターゲットは回転だけを写すので、被写体より VRM の股関節の間隔が狭いと、
// 足の左右の間隔も同じだけ狭くなる(正面から見ると足が交差して見える)。脚全体を骨盤の左右方向に、股関節の間隔の差(+ extra)の
// 半分だけ足首がずれる角度で開く(足首の向きは変えない)。W は更新し、親からのローカル回転を返す
function widenStance(W, bones, legRest, dHalf, parentOf, has) {
    if (!legRest || !W.hips || Math.abs(dHalf) < 1e-5) return;
    for (const [side, sign] of [['left', 1], ['right', -1]]) {
        const chain = ['UpperLeg', 'LowerLeg', 'Foot'].map(n => side + n);
        if (!chain.every(b => W[b] && legRest[b])) continue;
        // 股関節 → 足首のベクトル(腰を原点にしたワールド座標)
        const hipPos = qRotVec(W.hips, legRest[chain[0]]);
        const knee = qRotVec(W[chain[0]], legRest[chain[1]]);
        const ankle = qRotVec(W[chain[1]], legRest[chain[2]]);
        const v = [knee[0] + ankle[0], knee[1] + ankle[1], knee[2] + ankle[2]];
        const side3 = qRotVec(W.hips, [sign, 0, 0]);               // 骨盤の外向き
        const v2 = [v[0] + side3[0] * dHalf, v[1] + side3[1] * dHalf, v[2] + side3[2] * dHalf];
        const R = qArc(v, v2);
        const footW = W[chain[2]];
        W[chain[0]] = qNorm(qMul(R, W[chain[0]]));
        W[chain[1]] = qNorm(qMul(R, W[chain[1]]));
        for (const b of [chain[0], chain[2]]) {
            const p = parentOf(b);
            const l = qNorm(p ? qMul(qInv(W[p]), W[b]) : W[b]);
            bones[b] = { qx: l[0], qy: l[1], qz: l[2], qw: l[3] };
        }
        W[chain[2]] = footW;
        // 足首のローカル回転は足首のワールド回転を保つ向きで再計算(親が回ったぶん打ち消す)
        const pf = parentOf(chain[2]);
        const lf = qNorm(qMul(qInv(W[pf]), footW));
        bones[chain[2]] = { qx: lf[0], qy: lf[1], qz: lf[2], qw: lf[3] };
    }
}

function retargetNamedBvh(bvh, opts = {}) {
    const avail = opts.availableBones ?? null;
    const yaw = qAxis([0, 1, 0], opts.rootYawDeg ?? 0);
    const hm = opts.hipsMotion === false ? null : (Array.isArray(opts.hipsMotion) ? opts.hipsMotion : [1, 1, 1]);
    const has = (b) => !avail || avail.has(b);
    // 親は「このスケルトンから回転を作れるボーン」までさかのぼる(例: 指の Metacarpal は駆動しないのでレスト扱いで飛ばす)
    let driven = null;
    const parentOf = (b) => {
        let p = NAMED_PARENT[b] ?? VRM_BONE_MAP[b].parent;
        while (p && !(driven ? driven.has(p) : has(p))) p = NAMED_PARENT[p] ?? VRM_BONE_MAP[p].parent;
        return p;
    };
    const joints = bvh.joints;
    const byName = new Map(joints.map((j, i) => [j.name, i]));
    const isSynthDistal = (b) => /^(left|right)(Index|Middle|Ring|Little)Distal$/.test(b);

    // バインド(回転ゼロ)の関節位置 = オフセットの累積(世界座標にそろった T ポーズ)
    const P = [];
    joints.forEach((j, i) => {
        const pp = j.parent >= 0 ? P[j.parent] : [0, 0, 0];
        P[i] = [pp[0] + j.offset[0], pp[1] + j.offset[1], pp[2] + j.offset[2]];
    });
    const toPoint = (spec) => {
        if (spec.startsWith('end:')) {
            const i = byName.get(spec.slice(4));
            const e = i != null ? joints[i].endOffset : null;
            return i != null && e ? [P[i][0] + e[0], P[i][1] + e[1], P[i][2] + e[2]] : null;
        }
        const i = byName.get(spec);
        return i != null ? P[i] : null;
    };

    const needed = BONE_ORDER.filter(b => has(b) && NAMED_BONES[b] && byName.has(NAMED_BONES[b]));
    driven = new Set(needed);
    for (const b of BONE_ORDER) if (isSynthDistal(b) && has(b) && driven.has(b.replace('Distal', 'Intermediate'))) driven.add(b);
    if (!needed.includes('hips') || !needed.includes('leftUpperArm') || !needed.includes('leftUpperLeg')) {
        throw new Error('Unsupported BVH skeleton: expected named joints like hip / lShldr / lThigh (CMU, Daz) or a SAM3DBody BVH.');
    }
    // VRM の T ポーズ方向(T)→ バインド方向への補正 C_b。バインドは世界軸にそろっているので、ワールド回転 G がそのまま差分になる
    const C = {};
    for (const b of needed) {
        const T = opts.restDirs?.[b] ?? VRM_BONE_MAP[b].T;
        const from = P[byName.get(NAMED_BONES[b])];
        const spec = NAMED_TO[b];
        const to = spec ? toPoint(spec) : null;
        const bDir = to ? vSub(to, from) : null;
        // 腕・手首は手のひらの向き(小指の付け根→人差し指の付け根)も合わせて、ひねりを含めた補正にする。
        // 上腕・前腕・手で同じ基準を使い、手首・肘に補正のひねりが溜まらないようにする(SAM3DBody の経路と同じ考え方)
        const side = b.startsWith('left') ? 'l' : b.startsWith('right') ? 'r' : null;
        const pk = side && /(UpperArm|LowerArm|Hand)$/.test(b) ? toPoint(`${side}Pinky1`) : null;
        const ix = pk ? toPoint(`${side}Index1`) : null;
        const palm = pk && ix ? vSub(ix, pk) : null;
        C[b] = !to ? [0, 0, 0, 1]
            : palm && Math.abs(vDot(vNorm(palm), vNorm(bDir))) < 0.9 ? qFrameAlign(T, FWD, bDir, palm)
            : qArc(T, bDir);
    }

    // 腰高(バインドの腰から足裏まで)で位置の倍率を決める。単位に依らない比にする
    const hipsI = byName.get(NAMED_BONES.hips);
    const footEnd = byName.has('lFoot') ? toPoint('end:lFoot') : null;
    const subjectHeight = footEnd ? P[hipsI][1] - footEnd[1] : P[hipsI][1];
    const hipsScale = opts.hipsScale ?? (opts.vrmHipsHeight && subjectHeight > 0 ? opts.vrmHipsHeight / subjectHeight : 0.01);

    // 骨盤の幅の差(被写体を VRM のスケールに直した値 - VRM)の半分 + 利用者指定の追加ぶん(m)。片側に足す量
    let halfWiden = 0;
    if (opts.legRest && opts.hipWidthFix !== false && byName.has('lThigh') && byName.has('rThigh') && opts.legRest.leftUpperLeg && opts.legRest.rightUpperLeg) {
        const subjW = Math.abs(P[byName.get('lThigh')][0] - P[byName.get('rThigh')][0]) * hipsScale;
        const vrmW = Math.abs(opts.legRest.leftUpperLeg[0] - opts.legRest.rightUpperLeg[0]);
        halfWiden = (subjW - vrmW) / 2;
    }
    halfWiden += (opts.stanceExtra ?? 0) / 2;

    const keyframes = [], hips = [], legW = [];
    const G = new Array(joints.length);
    const frameIdx = selectFrames(bvh, opts);
    let p0 = null;
    for (const f of frameIdx) {
        const row = bvh.data[f];
        for (let i = 0; i < joints.length; i++) {
            const jt = joints[i];
            const o = jt.chOffset + (jt.channels.length - 3);
            const r = eulerByOrder(rotOrder(jt.channels), row[o], row[o + 1], row[o + 2]);
            G[i] = jt.parent >= 0 ? qMul(G[jt.parent], r) : r;
        }
        const W = {}, bones = {};
        for (const b of needed) {
            const gi = byName.get(NAMED_BONES[b]);
            W[b] = qNorm(qMul(yaw, qMul(G[gi], C[b])));
            const p = parentOf(b);
            const l = qNorm(p ? qMul(qInv(W[p]), W[b]) : W[b]);
            bones[b] = { qx: l[0], qy: l[1], qz: l[2], qw: l[3] };
        }
        if (halfWiden) widenStance(W, bones, opts.legRest, halfWiden, parentOf, has);
        // 先端の指(Distal)は中節のローカル回転の一部をコピー。親(中節)の W に続けて W も更新する
        for (const b of BONE_ORDER) {
            if (!isSynthDistal(b) || !has(b)) continue;
            const inter = b.replace('Distal', 'Intermediate');
            const q = bones[inter];
            if (!q) continue;
            const part = qScaleRotation([q.qx, q.qy, q.qz, q.qw], FINGER_DISTAL_SYNTH);
            bones[b] = { qx: part[0], qy: part[1], qz: part[2], qw: part[3] };
            W[b] = qNorm(qMul(W[inter], part));
        }
        keyframes.push({ time: (f - frameIdx[0]) * bvh.frameTime, bones });
        legW.push(W);

        const rj = joints[0];
        const pos = [row[rj.chOffset], row[rj.chOffset + 1], row[rj.chOffset + 2]];
        if (!p0) p0 = pos;
        const dlt = qRotVec(yaw, [pos[0] - p0[0], pos[1] - p0[1], pos[2] - p0[2]]).map(v => v * hipsScale);
        hips.push(dlt);
        if (hm && bones.hips) Object.assign(bones.hips, { px: dlt[0] * hm[0], py: dlt[1] * hm[1], pz: dlt[2] * hm[2] });
    }
    // モーキャプは足の位置が正確なので、BVH 自身の足の最下点の高さ(クリップ全体で一番低い所を床とする)を正解にして
    // VRM の足の高さをそれに合わせる。床から離れるジャンプ・側転・逆立ちをそのまま保つ(推定用の吸着は使わない)
    let target = null;
    if (hm && opts.groundMode !== 'estimate' && opts.restHipsY != null) {
        const low = footLowestHeights(bvh, joints, byName, frameIdx, P, 0.035 * subjectHeight); // 帯の幅は腰高の 3.5%(約 3cm)
        // 床より下には沈めない(モーキャプのノイズで足が床の推定より大きく下がるフレームがある)
        if (low) target = low.heights.map(v => Math.max(0, (v - low.floor) * hipsScale));
    }
    postProcessFeet(keyframes, hips, legW, opts, hm, parentOf, has, target);
    return { fps: bvh.fps, duration: (frameIdx[frameIdx.length - 1] - frameIdx[0]) * bvh.frameTime, frames: keyframes.length, keyframes, hips };
}

// BVH の FK で、両足(足首と End Site)の最下点の高さ(BVH の単位)を返す。floor はクリップ全体の最小値
// 足裏の 2 点(かかと・つま先)で測る。バインドは足裏が床にある T ポーズ前提で、足首の高さ・End Site の高さが足裏までの距離
function footLowestHeights(bvh, joints, byName, frameIdx, P, band) {
    const feet = ['lFoot', 'rFoot'].map(n => byName.get(n)).filter(i => i != null);
    if (!feet.length || feet.some(i => !joints[i].endOffset)) return null;
    // 根から各足までの祖先の列
    const chains = feet.map(fi => { const c = []; for (let i = fi; i >= 0; i = joints[i].parent) c.unshift(i); return c; });
    const lowestAt = (row) => {
        let m = Infinity;
        for (const chain of chains) {
            let G = null, pos = null;
            for (const i of chain) {
                const jt = joints[i];
                const o = jt.chOffset + jt.channels.length - 3;
                const r = eulerByOrder(rotOrder(jt.channels), row[o], row[o + 1], row[o + 2]);
                if (G) { const off = qRotVec(G, jt.offset); pos = [pos[0] + off[0], pos[1] + off[1], pos[2] + off[2]]; G = qMul(G, r); }
                else { pos = [row[jt.chOffset], row[jt.chOffset + 1], row[jt.chOffset + 2]]; G = r; }
            }
            const fi = chain[chain.length - 1], fj = joints[fi];
            const heelDrop = P[fi][1];                    // バインドの足首の高さ = かかとの足裏までの距離
            const toeDrop = P[fi][1] + fj.endOffset[1];   // バインドの End Site の高さ = つま先の足裏までの距離
            m = Math.min(m, pos[1] + qRotVec(G, [0, -heelDrop, 0])[1]);
            m = Math.min(m, pos[1] + qRotVec(G, [fj.endOffset[0], fj.endOffset[1] - toeDrop, fj.endOffset[2]])[1]);
        }
        return m;
    };
    const all = [];
    for (let f = 0; f < bvh.frames; f++) all.push(lowestAt(bvh.data[f]));
    return { floor: estimateFloor(all, band), heights: frameIdx.map(f => all[f]) };
}

// 床の高さの推定: 足裏の最下点の高さのうち、band 以内に全体の 8%(最低 3 フレーム)以上が集まる最も低い帯の下端。
// モーキャプは床の高さがクリップごとにずれていたり、最初の T ポーズや 1 フレームの外れ値で最小値が低すぎたりするため、最小値は使わない
function estimateFloor(lows, band) {
    const sorted = [...lows].sort((a, b) => a - b);
    const need = Math.max(3, Math.ceil(0.08 * sorted.length));
    let j = 0;
    for (let i = 0; i < sorted.length; i++) {
        if (j < i) j = i;
        while (j + 1 < sorted.length && sorted[j + 1] <= sorted[i] + band) j++;
        if (j - i + 1 >= need) return sorted[i];
    }
    return sorted[0];
}

// 回転 q の角度を t 倍にした回転(単位クォータニオンから q へ t だけ進める)
function qScaleRotation(q, t) {
    const w = Math.min(1, Math.max(-1, q[3]));
    const ang = 2 * Math.acos(Math.abs(w));
    const sinH = Math.sqrt(Math.max(0, 1 - w * w));
    if (ang < 1e-6 || sinH < 1e-9) return [0, 0, 0, 1];
    const sg = w < 0 ? -1 : 1;
    const ax = [q[0] / sinH * sg, q[1] / sinH * sg, q[2] / sinH * sg];
    const h = ang * t / 2;
    return [ax[0] * Math.sin(h), ax[1] * Math.sin(h), ax[2] * Math.sin(h), Math.cos(h)];
}


// ---- 接地補正 ----
// 単眼動画から出る腰の高さは、最初のフレームを基準にした相対値(最初のフレームが開脚・しゃがみでも立ち姿の腰高になる)ため、
// 足がまとめて浮く/沈む。脚チェーンを VRM のレスト寸法で FK して足の最下点の高さを求め、
//   1) 全体オフセット: 最下点の下位 5% が床に着くように腰を上下する
//   2) フレームごと: 床から snap[0](15cm)以内は床に吸着、snap[1](35cm)まで補正を弱める(それ以上浮くジャンプは残す)。軽く平滑化
//      推定誤差で数 cm〜十数 cm 浮くことが多く、本当の跳躍(30cm 超)は少ないため広めに取る
// 横方向の足の滑りは補正しない(接地中の水平速度は中央値 0.1m/s 程度で小さい)
// target(フレームごとの正解の足の最下点の高さ[m]、モーキャプ用)があれば、推定用の吸着はせず、その高さに合わせる
// (ジャンプ・側転など床から離れる動きもそのまま残る)
function groundFeet(keyframes, hips, legW, rest, hm, snap = [0.15, 0.35], target = null, restHipsY = null) {
    const chains = [['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes'], ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']];
    if (!chains.every(c => rest[c[0]] && rest[c[1]] && rest[c[2]])) return;
    // 足裏の 2 点(かかと・つま先)で測るモード(target あり + レストの腰高が分かるとき)。足首・つま先の関節だけで測ると、
    // つま先立ちなどで足の向きが変わったときに最下点の定義がずれて、床の基準が数 cm ずれる。
    // 関節の真下の足裏までの距離は、レスト(足裏が床 y=0)の関節の高さ。
    let soleDrop = null;
    if (target && restHipsY != null) {
        soleDrop = chains.map(c => {
            let y = restHipsY;
            const out = {};
            for (const b of c) {
                if (!rest[b]) break;
                y += rest[b][1];
                if (b.endsWith('Foot')) out.heel = y;
                if (b.endsWith('Toes')) out.toe = y;
            }
            return out;
        });
    }
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
                if (soleDrop) {
                    // この関節の向きで、関節の真下(足裏)の点の高さ。toes が駆動されない骨格では足の向きに従う
                    const rotHere = W[b] ?? parentRot;
                    if (b.endsWith('Foot') && soleDrop[ci].heel != null) m = Math.min(m, pos[1] + qRotVec(rotHere, [0, -soleDrop[ci].heel, 0])[1]);
                    if (b.endsWith('Toes') && soleDrop[ci].toe != null) m = Math.min(m, pos[1] + qRotVec(rotHere, [0, -soleDrop[ci].toe, 0])[1]);
                } else if (b.endsWith('Foot') || b.endsWith('Toes')) {
                    m = Math.min(m, pos[1]);
                }
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
    let g = 0, c;
    if (target) {
        c = h.map((v, i) => target[i] - v); // 足の最下点を正解の高さに合わせる補正量
    } else {
        const sorted = [...h].sort((a, b) => a - b);
        g = -sorted[Math.floor(0.05 * (n - 1))]; // 下位 5% が床に着くオフセット
        const raw = h.map(v => v + g);
        // 床から近いフレームは吸着、離れるほど補正を弱める
        const corr = raw.map(v => {
            const a = Math.abs(v);
            const w = a <= snap[0] ? 1 : a >= snap[1] ? 0 : 1 - (a - snap[0]) / (snap[1] - snap[0]);
            return -v * w;
        });
        // 3 点ガウス平滑(2 回)
        c = corr;
        for (let k = 0; k < 2; k++) c = c.map((v, i) => 0.25 * (c[Math.max(0, i - 1)] + c[Math.min(n - 1, i + 1)]) + 0.5 * v);
    }
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
    const named = bvh.kind === 'named'; // 名前つき骨格は単位に依らない比で倍率を決めるため、VRM の腰高だけ渡す
    const restDirs = restFingerDirs(editor.getVRM?.());
    const legRest = restLegOffsets(editor.getVRM?.());
    const result = retargetBvh(bvh, {
        availableBones, restDirs, legRest, restHipsY: restHips ? restHips[1] : null, ...opts,
        ...(named ? { vrmHipsHeight: restHips ? restHips[1] : null } : { hipsScale }),
    });
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
