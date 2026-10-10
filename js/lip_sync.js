// 口形同期(リップシンク)の最小実装。
// テキストから「母音(口形)のタイムライン」を作り、音声の音量で口の開き具合を決めて
// VRM の表情(aa / ih / ou / ee / oh)に反映する。
//
// 音素の厳密なタイミングは持たず、文字の並びから作った大まかな時間配分で母音を切り替える。
// 0.x モデルの表情名 (a/i/u/e/o) は three-vrm が読み込み時に aa/ih/ou/ee/oh へ変換するので、
// ここでは 1.0 の名前だけを使う。

export const MOUTH_VISEMES = ["aa", "ih", "ou", "ee", "oh"];

// 文字列 → 母音。かなは行の母音で決まる(ぁぃぅぇぉゃゅょゎ等の小書きも含む)
const KANA_ROWS = {
    aa: "あかがさざただだなはばぱまやゃらわゎぁ",
    ih: "いきぎしじちぢにひびぴみりぃ",
    ou: "うくぐすずつづぬふぶぷむゆゅるぅゔ",
    ee: "えけげせぜてでねへべぺめれぇ",
    oh: "おこごそぞとどのほぼぽもよょろをぉ",
};
const KANA_VOWEL = new Map();
for (const [viseme, chars] of Object.entries(KANA_ROWS)) {
    for (const ch of chars) KANA_VOWEL.set(ch, viseme);
}

// 英語の母音グループ → 口形。1文字の母音と、よくある2文字の組み合わせのみ
const EN_SINGLE = { a: "aa", e: "ee", i: "ih", y: "ih", o: "oh", u: "ou" };
const EN_GROUP = {
    ee: "ee", ea: "ee", ie: "ee", ei: "ee", ey: "ee",
    oo: "ou", ou: "ou", ow: "ou", ue: "ou", ui: "ou",
    oi: "oh", oy: "oh", oa: "oh",
    ai: "aa", ay: "aa",
};

// 1単位あたりの基準の長さ(重み1 = 約110ms)。文字数からの長さ推定に使う
const SECONDS_PER_WEIGHT = 0.11;

// 文字列を「口形 + 重み」の単位列に分解する。v が null は口を閉じる(子音・無音)
function buildVisemeUnits(text) {
    const units = [];
    const push = (v, w) => units.push({ v, w });

    const englishWord = (word) => {
        const lw = word.toLowerCase();
        const parts = lw.match(/[aeiouy]+|[^aeiouy]+/g) ?? [];
        const vowelCount = parts.filter(p => /[aeiouy]/.test(p)).length;
        parts.forEach((part, idx) => {
            if (!/[aeiouy]/.test(part)) { push(null, 0.35); return; }
            // 語末の単独 e は発音されないことが多いので、短い単語以外は口形を付けない
            if (part === "e" && idx === parts.length - 1 && lw.length > 2 && vowelCount > 1) {
                push(null, 0.2);
                return;
            }
            const v = (part.length > 1 && EN_GROUP[part.slice(0, 2)]) || EN_SINGLE[part[0]];
            push(v, 1);
        });
    };

    const re = /[A-Za-z]+|[぀-ヿ]|[㐀-鿿豈-﫿]|[\s\S]/g;
    for (const m of text.matchAll(re)) {
        const s = m[0];
        if (/^[A-Za-z]+$/.test(s)) { englishWord(s); continue; }
        if (/^[぀-ヿ]$/.test(s)) {
            // カタカナはひらがなに揃えてから母音を引く
            const code = s.charCodeAt(0);
            const hira = code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : s;
            if (hira === "ー") {
                // 長音は直前の母音を伸ばす
                const prev = units[units.length - 1];
                push(prev?.v ?? null, 0.8);
            } else if (hira === "ん" || hira === "ン") {
                push(null, 0.5);
            } else if (hira === "っ" || hira === "ッ") {
                push(null, 0.4);
            } else {
                push(KANA_VOWEL.get(hira) ?? null, 1);
            }
            continue;
        }
        // 漢字は読みを持たないため、口を開けた単位として仮置きする(読みはかな入力で正確になる)
        if (/^[㐀-鿿豈-﫿]$/.test(s)) { push("aa", 1); continue; }
        if (/[、。,.!?！？]/.test(s)) { push(null, 0.8); continue; }
        if (/\s/.test(s)) { push(null, 0.5); continue; }
        push(null, 0.3);
    }
    return units;
}

// 文字列から再生時間の推定値(秒)を返す。音声の長さが分からないときのプレビュー用
export function estimateSpeechDuration(text) {
    return buildVisemeUnits(text).reduce((s, u) => s + u.w, 0) * SECONDS_PER_WEIGHT;
}

// 文字列 → タイムライン。durationSec は音声の実際の長さ(分からなければ estimateSpeechDuration)
export function buildVisemeTimeline(text, durationSec) {
    const units = buildVisemeUnits(text);
    const total = units.reduce((s, u) => s + u.w, 0) || 1;
    const duration = durationSec > 0 ? durationSec : total * SECONDS_PER_WEIGHT;
    let t = 0;
    const timed = units.map(u => {
        const d = (u.w / total) * duration;
        const item = { v: u.v, t0: t, t1: t + d };
        t += d;
        return item;
    });
    return { units: timed, duration };
}

// 音声要素の音量(0..1)を読む。AudioContext は再生開始のユーザー操作の後に作ること
export function attachAudioLevelMeter(audioEl) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(audioEl);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const buf = new Float32Array(analyser.fftSize);
    return {
        read() {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);
            // 通常の話し声の RMS(0.05〜0.2 程度)が口の開きに広く反映されるよう増幅する
            return Math.min(1, Math.max(0, (rms - 0.01) * 5));
        },
        close() { ctx.close(); },
    };
}

// ---- 口の開きレベル(S タブで調整。ブラウザの localStorage に保存) ----
//   text : テキスト再生(音量なし)での口の開き 0..1
//   audio: 音声再生での音量の増幅倍率(結果は 1 で頭打ち)
const LEVELS_KEY = "vrm_pose_editor.lip_levels";
export const LIP_LEVEL_DEFAULTS = { text: 0.5, audio: 1.5 };
let _levels = { ...LIP_LEVEL_DEFAULTS };
try {
    const saved = JSON.parse(localStorage.getItem(LEVELS_KEY) ?? "null");
    for (const k of Object.keys(_levels)) {
        if (typeof saved?.[k] === "number" && isFinite(saved[k]) && saved[k] >= 0) _levels[k] = saved[k];
    }
} catch { /* 保存値が読めなければ既定値 */ }
export function getLipLevels() { return { ..._levels }; }
export function setLipLevels(partial) {
    for (const k of Object.keys(_levels)) {
        if (typeof partial?.[k] === "number" && isFinite(partial[k]) && partial[k] >= 0) _levels[k] = partial[k];
    }
    try { localStorage.setItem(LEVELS_KEY, JSON.stringify(_levels)); } catch { /* 保存できなくても動作は続ける */ }
}
// 音量 0..1(attachAudioLevelMeter の read 相当)に音声用の倍率を掛ける
export function scaleAudioLevel(level) { return Math.min(1, level * _levels.audio); }

// 音声ファイルを先に解析して、時間ごとの音量(口の開き)の列を作る。キーフレーム(書き出し含む)用。
// attachAudioLevelMeter と同じ RMS・増幅で、1/ENV_RATE 秒ごとの値(倍率は掛けない)を返す
const ENV_RATE = 50;
export async function analyzeAudioFile(file) {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const data = audio.getChannelData(0);
    const win = 1024;
    const n = Math.max(1, Math.ceil(audio.duration * ENV_RATE));
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const end = Math.min(data.length, Math.floor((i + 1) / ENV_RATE * audio.sampleRate));
        const start = Math.max(0, end - win);
        let sum = 0;
        for (let j = start; j < end; j++) sum += data[j] * data[j];
        const rms = end > start ? Math.sqrt(sum / (end - start)) : 0;
        env[i] = Math.min(1, Math.max(0, (rms - 0.01) * 5));
    }
    return { duration: audio.duration, rate: ENV_RATE, env };
}

// VRM の表情に口形を反映する。毎フレーム update() を呼ぶ
export class LipSync {
    constructor(expressionManager) {
        this.em = expressionManager;
        this.timeline = null;
        this.cursor = 0;
        this.current = Object.fromEntries(MOUTH_VISEMES.map(k => [k, 0]));
        // 表情がモデルにあるかどうか(0.x でも 1.0 でも aa/ih/... で見つかる)
        this.available = Object.fromEntries(MOUTH_VISEMES.map(k => [k, !!expressionManager?.getExpression?.(k)]));
    }

    setTimeline(timeline) {
        this.timeline = timeline;
        this.cursor = 0;
    }

    // t: タイムライン上の時刻(秒)。level: 音量 0..1(倍率適用済み)。null なら文字だけのプレビュー(テキスト用レベルの一定の開き)
    update(t, level, dtSec) {
        const units = this.timeline?.units ?? [];
        let target = null;
        if (units.length > 0) {
            if (this.cursor > 0 && t < units[this.cursor].t0) this.cursor = 0;
            while (this.cursor < units.length - 1 && t >= units[this.cursor].t1) this.cursor++;
            const u = units[this.cursor];
            if (u.v && t >= u.t0 && t < u.t1) {
                target = { v: u.v, amount: level == null ? _levels.text : level };
            }
        }

        // 口を開くときは速く、閉じるときは少しゆっくりにして、母音の切り替わりの破綻を抑える
        const dt = Math.max(0, dtSec);
        for (const k of MOUTH_VISEMES) {
            const goal = target && target.v === k ? target.amount : 0;
            const rate = goal > this.current[k] ? 30 : 14;
            this.current[k] += (goal - this.current[k]) * (1 - Math.exp(-rate * dt));
            if (this.available[k]) this.em.setValue(k, this.current[k]);
        }
    }

    // baseline: 再生前の口形の値(手動で設定していた値)。省略時は 0 に戻す
    reset(baseline = null) {
        for (const k of MOUTH_VISEMES) {
            this.current[k] = 0;
            if (this.available[k]) this.em.setValue(k, baseline?.[k] ?? 0);
        }
    }
}

// デバッグ用: 単位列を「文字→口形」の読みやすい文字列にする
export function describeTimeline(timeline, maxItems = 80) {
    return timeline.units.slice(0, maxItems)
        .map(u => `${u.v ?? "-"}(${(u.t1 - u.t0).toFixed(2)}s)`)
        .join(" ");
}
