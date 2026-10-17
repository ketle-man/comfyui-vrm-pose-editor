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
            cur = { name: m[2], parent, channels: [], chOffset: 0, mhr: null };
            joints.push(cur);
            stack.push(joints.length - 1);
            m = /^joint_(\d+)$/.exec(cur.name);
            cur.mhr = m ? parseInt(m[1], 10) : (parent < 0 ? 1 : null);
        } else if (s.startsWith('End Site')) {
            stack.push(-2);
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
    leftUpperArm:  { j: 75,  to: 76,   T: LX, parent: 'leftShoulder' },
    leftLowerArm:  { j: 76,  to: 77,   T: LX, parent: 'leftUpperArm' },
    leftHand:      { j: 78,  to: 88,   T: LX, parent: 'leftLowerArm' },
    rightShoulder: { j: 38,  to: 39,   T: RX, parent: 'upperChest' },
    rightUpperArm: { j: 39,  to: 40,   T: RX, parent: 'rightShoulder' },
    rightLowerArm: { j: 40,  to: 41,   T: RX, parent: 'rightUpperArm' },
    rightHand:     { j: 42,  to: 52,   T: RX, parent: 'rightLowerArm' },
    leftUpperLeg:  { j: 2,   to: 3,    T: DOWN, parent: 'hips' },
    leftLowerLeg:  { j: 3,   to: 4,    T: DOWN, parent: 'leftUpperLeg' },
    leftFoot:      { j: 4,   to: 7,    T: FWD, parent: 'leftLowerLeg' },
    leftToes:      { j: 7,   to: 8,    T: FWD, parent: 'leftFoot' },
    rightUpperLeg: { j: 18,  to: 19,   T: DOWN, parent: 'hips' },
    rightLowerLeg: { j: 19,  to: 20,   T: DOWN, parent: 'rightUpperLeg' },
    rightFoot:     { j: 20,  to: 23,   T: FWD, parent: 'rightLowerLeg' },
    rightToes:     { j: 23,  to: 24,   T: FWD, parent: 'rightFoot' },
};
const BONE_ORDER = Object.keys(VRM_BONE_MAP); // 親が先に並んでいる

// VRM の T ポーズ → MHR バインドの補正回転 C_b を作る(一度だけ)
const _C = {};
for (const [name, d] of Object.entries(VRM_BONE_MAP)) {
    if (d.to == null) { _C[name] = [0, 0, 0, 1]; continue; }
    _C[name] = qArc(d.T, vSub(MHR_BIND[d.to].p, MHR_BIND[d.j].p));
}

// ---- リターゲット本体 ----
// opts.availableBones: 読み込み中モデルが持つボーン名の Set(省略時は全ボーン)。upperChest 等が無い VRM では親を付け替える。
// opts.rootYawDeg: 全体を Y 軸まわりに回す角度(度)。映像内で人物がカメラを向くとき VRM を +Z 向きにそろえる補正
// opts.hipsScale: Hips 位置の倍率(VRM の腰高 / MHR の腰高 0.924 など)。省略時 1(メートル相当)
// 戻り値: { fps, duration, frames, keyframes:[{time, bones:{name:{qx,qy,qz,qw}}}], hips:[[x,y,z]...] (最初のフレーム基準の移動量[m]) }
export function retargetBvh(bvh, opts = {}) {
    const avail = opts.availableBones ?? null;
    const yaw = qAxis([0, 1, 0], opts.rootYawDeg ?? 0);
    const hipsScale = opts.hipsScale ?? 1;
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

        const rj = joints[0];
        const pos = [row[rj.chOffset], row[rj.chOffset + 1], row[rj.chOffset + 2]].map(v => v * 0.01); // cm → m
        if (!p0) p0 = pos;
        const dlt = qRotVec(yaw, [pos[0] - p0[0], pos[1] - p0[1], pos[2] - p0[2]]).map(v => v * hipsScale);
        hips.push(dlt);
    }
    return { fps: bvh.fps, duration: (bvh.frames - 1) * bvh.frameTime, frames: bvh.frames, keyframes, hips };
}

// VRM1 正準空間のキーフレームを VRM0 モデル用(exportVrma が x,z を反転して正準化する前提)に変換する
export function keyframesToVrm0(keyframes) {
    return keyframes.map(k => {
        const bones = {};
        for (const [n, q] of Object.entries(k.bones)) bones[n] = { qx: -q.qx, qy: q.qy, qz: -q.qz, qw: q.qw };
        return { time: k.time, bones };
    });
}

// SAM3DBody の BVH テキスト → .vrma(ArrayBuffer)。読み込み中の VRM(editor)のボーン構成・VRM0/1 に合わせる。
// 戻した .vrma は importVrmaAsKeyframes(Light & Pose Editor のキーフレーム取り込み)にそのまま渡せる。
export async function bvhTextToVrmaBuffer(editor, text, opts = {}) {
    const poseJson = editor.exportPose();
    if (!poseJson) throw new Error('Load a VRM model before importing a BVH.');
    const availableBones = new Set(Object.keys(JSON.parse(poseJson).bones));
    const result = retargetBvh(parseBvh(text), { availableBones, ...opts });
    const isVrm0 = editor.getVRM?.()?.meta?.metaVersion === '0';
    const kfs = isVrm0 ? keyframesToVrm0(result.keyframes) : result.keyframes;
    return editor.exportVrma(kfs);
}
