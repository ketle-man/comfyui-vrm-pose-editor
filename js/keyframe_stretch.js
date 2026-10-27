// keyframe_stretch.js — キーフレームのタイムストレッチ(範囲内のキーの間隔を伸縮する)の計算部分。
// UI(ダイアログ・キーフレームへの書き戻し)は pose_vrma_export.js の buildKeyframePanel 側にある。
// DOM や editor に依存しない純粋な関数だけを置き、node から単体で確かめられるようにしている。

// フレーム f の伸縮後の位置(小数)。range: { start, end, newLength, shiftAfter }
//   start〜end のキーは start を起点に newLength / (end - start) 倍の間隔にする。
//   end より後ろのキーは shiftAfter なら伸縮で増減した長さだけずらし、そうでなければ動かさない。start より前は動かさない
export function stretchFrame(f, { start, end, newLength, shiftAfter = true }) {
    if (f < start) return f;
    if (f <= end) return start + (f - start) * (newLength / (end - start));
    return shiftAfter ? f + (newLength - (end - start)) : f;
}

// 1 トラック分のキー(元のフレーム番号の配列)の移動先を決める。
// 戻り値: { moves: Map<元のフレーム, 新しいフレーム>, dropped: [元のフレーム...] }
// 縮めると複数のキーが同じフレームに丸められることがある(動画から取り込んだ毎フレームのキーなど)。
// 同じフレームに来たキーは、伸縮後の位置(小数)がそのフレームに一番近いものだけを残し、ほかは間引く。
// 範囲外で動かないキーは位置の誤差が 0 なので必ず残る(動かしたキーのほうが間引かれる)
export function planTrackStretch(frames, range) {
    const best = new Map(); // 新しいフレーム → { from, err }
    for (const from of frames) {
        const x = Math.max(0, stretchFrame(from, range));
        const to = Math.round(x);
        const err = Math.abs(x - to);
        const cur = best.get(to);
        if (!cur || err < cur.err - 1e-9) best.set(to, { from, err });
    }
    const moves = new Map();
    for (const [to, { from }] of best) moves.set(from, to);
    const dropped = frames.filter(f => !moves.has(f));
    return { moves, dropped };
}
