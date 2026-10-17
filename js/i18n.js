// UI 文言の多言語化(最小構成)。言語は ComfyUI の設定(Comfy.Locale)→ ブラウザの言語の順で決め、
// 辞書に無い言語は英語にフォールバックする。言語を増やすときは、使う側の辞書にその言語コードのキーを足すだけ。

// 'ja' / 'en' / 'zh' など 2 文字の言語コードを返す(判定できなければ 'en')
export function detectLang() {
    let loc = null;
    try { loc = window.app?.extensionManager?.setting?.get?.('Comfy.Locale'); } catch { /* 設定を読めない環境はブラウザの言語へ */ }
    if (!loc) { try { loc = navigator.language; } catch { /* ignore */ } }
    return String(loc || 'en').toLowerCase().split(/[-_]/)[0] || 'en';
}

// dicts: { en: {key: text}, ja: {...} }。戻り値の t(key, vars?) は {name} を vars で置換する。
// 現在の言語に無いキーは英語、英語にも無ければキー名をそのまま返す。lang を渡すとその言語に固定(テスト用)
export function makeT(dicts, lang) {
    const l = lang ?? detectLang();
    const dict = dicts[l] ?? {};
    const fallback = dicts.en ?? {};
    return (key, vars) => {
        let s = dict[key] ?? fallback[key] ?? key;
        if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
        return s;
    };
}
