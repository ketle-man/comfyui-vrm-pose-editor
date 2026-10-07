// 音声ファイル(A タブ)と API 設定(S タブ)の UI。サーバー側は pose_audio_server.py
//
// 「選択中の音声」は A タブと Lip Sync 行で共有する。音声ファイルは <output>/vrm_pose_editor/Audio に置かれる。
import { fetchApi } from "./comfy_api.js";

// ---- 選択中の音声(A タブ・Lip Sync 行で共有) ----
let _selected = null;
const _selectedListeners = new Set();
export function getSelectedAudio() { return _selected; }
export function setSelectedAudio(name) {
    _selected = name ?? null;
    _selectedListeners.forEach(fn => fn(_selected));
}
export function onSelectedAudioChange(fn) {
    _selectedListeners.add(fn);
    return () => _selectedListeners.delete(fn);
}

// ---- 音声一覧の更新通知(音声を新しく作成したときに A タブを更新する) ----
const _listListeners = new Set();
export function onAudioListChange(fn) {
    _listListeners.add(fn);
    return () => _listListeners.delete(fn);
}
function notifyAudioListChange() {
    _listListeners.forEach(fn => fn());
}

// ---- サーバー呼び出し ----
// text から音声を作成し、保存されたファイル名を返す。voice を省略するとサーバー側の既定の声を使う
export async function generateSpeech(text, voice) {
    const res = await fetchApi("/pose_editor/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    notifyAudioListChange();
    return data.name;
}

// 保存済みの音声を File として取得する(Lip Sync の再生・A タブの試聴に使う)
export async function fetchAudioFile(name) {
    const res = await fetchApi(`/pose_editor/audio/file/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return new File([blob], name, { type: blob.type || "audio/mpeg" });
}

// ---- 小さな UI 部品 ----
function el(tag, style, text) {
    const e = document.createElement(tag);
    e.style.cssText = style;
    if (text !== undefined) e.textContent = text;
    return e;
}
function smallBtn(label, bg, title) {
    const b = el("button", `padding:4px 9px;background:${bg};color:#fff;border:none;border-radius:4px;` +
                           "cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap;", label);
    b.title = title ?? "";
    return b;
}
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ================================================================
// A タブ: 音声ファイルの一覧。操作は上部の共通ツールバーに集約し、
// 行のチェックボックスで対象を選ぶ
//   ・選択 / 再生: チェックが 1 件のとき、その音声を対象にする
//   ・削除: チェックしたすべての音声を削除する
// ================================================================
export function buildAudioTab() {
    const root = el("div", "display:none;flex-direction:column;flex:1;overflow:hidden;");

    // 上部: タイトル・更新
    const head = el("div", "display:flex;align-items:center;gap:6px;padding:7px 10px;" +
                           "border-bottom:1px solid #2a2a4a;flex-shrink:0;");
    const title = el("span", "font-size:12px;font-weight:bold;color:#aaa;flex:1;", "Audio");
    const refreshBtn = smallBtn("↻", "#333344", "一覧を更新");
    head.append(title, refreshBtn);

    // 共通ツールバー: 選択・再生・削除・全選択
    const toolbar = el("div", "display:flex;align-items:center;gap:6px;padding:6px 10px;flex-wrap:wrap;" +
                              "border-bottom:1px solid #2a2a4a;flex-shrink:0;");
    const selectBtn = smallBtn("✓ 選択", "#3a6a1a", "チェックした 1 件を Lip Sync の音声に選ぶ");
    const playBtn = smallBtn("▶ 再生", "#2a6a8a", "チェックした 1 件を試聴する");
    const deleteBtn = smallBtn("🗑 削除", "#6a2a2a", "チェックしたすべての音声を削除する");
    const allBtn = smallBtn("全選択", "#333344", "すべての行をチェック / 解除");
    toolbar.append(selectBtn, playBtn, deleteBtn, allBtn);

    const selLabel = el("div", "font-size:11px;color:#8fd;padding:6px 10px;border-bottom:1px solid #2a2a4a;" +
                               "word-break:break-all;flex-shrink:0;");
    const list = el("div", "flex:1;overflow-y:auto;padding:6px 8px;display:flex;flex-direction:column;gap:4px;");
    const status = el("div", "font-size:11px;color:#888;padding:4px 10px;flex-shrink:0;");
    root.append(head, toolbar, selLabel, list, status);

    let previewAudio = null;
    let files = [];                      // 現在の一覧(サーバーの順)
    const rows = new Map();              // name -> { row, check }

    const checkedNames = () => files.map(f => f.name).filter(n => rows.get(n)?.check.checked);

    // ツールバーの有効・無効をチェック状態に合わせる(無効のボタンはグレーアウトして押せない)
    function setEnabled(btn, on) {
        btn.disabled = !on;
        btn.style.opacity = on ? "1" : "0.35";
        btn.style.cursor = on ? "pointer" : "not-allowed";
    }
    function updateToolbar() {
        const count = checkedNames().length;
        setEnabled(selectBtn, count === 1);
        setEnabled(playBtn, count === 1);
        setEnabled(deleteBtn, count >= 1);
        setEnabled(allBtn, files.length > 0);
    }

    // チェックが 1 件だけならその名前、それ以外は null(メッセージを出す)
    function singleChecked(actionLabel) {
        const names = checkedNames();
        if (names.length !== 1) {
            status.textContent = names.length === 0
                ? `${actionLabel}する音声にチェックを入れてください。`
                : `${actionLabel}は 1 件だけチェックしてください（現在 ${names.length} 件）。`;
            return null;
        }
        return names[0];
    }

    function renderSelected(name) {
        selLabel.textContent = name ? `選択中: ${name}` : "選択中: なし";
        rows.forEach(({ row }, n) => {
            row.style.background = n === name ? "#1f3a2a" : "#1c1c2c";
        });
    }

    async function playName(name) {
        try {
            const file = await fetchAudioFile(name);
            if (previewAudio) previewAudio.pause();
            previewAudio = new Audio(URL.createObjectURL(file));
            await previewAudio.play();
            status.textContent = `再生中: ${name}`;
        } catch (e) {
            status.textContent = `再生できませんでした: ${e.message}`;
        }
    }

    async function deleteNames(names) {
        if (!confirm(`${names.length} 件の音声ファイルを削除しますか？\n\n${names.join("\n")}`)) return;
        let failed = [];
        for (const name of names) {
            try {
                const res = await fetchApi("/pose_editor/audio/delete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                if (getSelectedAudio() === name) setSelectedAudio(null);
            } catch (e) {
                failed.push(name);
            }
        }
        await refresh();
        status.textContent = failed.length
            ? `削除できなかった音声があります: ${failed.join(", ")}`
            : `${names.length} 件を削除しました。`;
    }

    selectBtn.onclick = () => {
        const name = singleChecked("選択");
        if (!name) return;
        setSelectedAudio(name);
        // 選択が決まったらチェックは外す(選択中はハイライトで分かるため)
        rows.forEach(({ check }) => { check.checked = false; });
        updateToolbar();
        status.textContent = `選択しました: ${name}`;
    };
    playBtn.onclick = () => {
        const name = singleChecked("再生");
        if (name) playName(name);
    };
    deleteBtn.onclick = () => {
        const names = checkedNames();
        if (names.length === 0) {
            status.textContent = "削除する音声にチェックを入れてください。";
            return;
        }
        deleteNames(names);
    };
    allBtn.onclick = () => {
        const allOn = files.length > 0 && files.every(f => rows.get(f.name)?.check.checked);
        rows.forEach(({ check }) => { check.checked = !allOn; });
        updateToolbar();
    };

    async function refresh() {
        status.textContent = "読み込み中…";
        try {
            const res = await fetchApi("/pose_editor/audio/list");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            files = data.files;
            list.replaceChildren();
            rows.clear();
            for (const f of files) {
                const row = el("div", "display:flex;align-items:center;gap:6px;padding:5px 6px;" +
                                       "border:1px solid #2a2a4a;border-radius:4px;background:#1c1c2c;");
                const check = document.createElement("input");
                check.type = "checkbox";
                check.style.cssText = "flex-shrink:0;cursor:pointer;";
                check.title = "操作の対象にする";
                check.onchange = updateToolbar;
                const nameEl = el("div", "flex:1;min-width:0;font-size:11px;color:#ddd;overflow:hidden;" +
                                         "text-overflow:ellipsis;white-space:nowrap;cursor:pointer;", f.name);
                nameEl.title = f.name;
                nameEl.onclick = () => { check.checked = !check.checked; updateToolbar(); };
                const sizeEl = el("div", "font-size:10px;color:#888;flex-shrink:0;", formatSize(f.size));
                row.append(check, nameEl, sizeEl);
                list.append(row);
                rows.set(f.name, { row, check });
            }
            renderSelected(getSelectedAudio());
            updateToolbar();
            status.textContent = files.length === 0
                ? "音声ファイルがありません。Lip Sync 欄の「テキストから音声を作成」で作れます。"
                : `${files.length} 件 · ${data.dir}`;
        } catch (e) {
            status.textContent = `一覧を読み込めませんでした: ${e.message}`;
        }
    }

    refreshBtn.onclick = () => refresh();
    onSelectedAudioChange(renderSelected);
    onAudioListChange(() => { if (root.style.display !== "none") refresh(); });
    updateToolbar();

    return { el: root, refresh };
}

// ================================================================
// S タブ: API 設定(Lemonade など)
// ================================================================
export function buildSettingsTab() {
    const root = el("div", "display:none;flex-direction:column;flex:1;overflow:hidden;");

    const head = el("div", "display:flex;align-items:center;gap:6px;padding:7px 10px;" +
                           "border-bottom:1px solid #2a2a4a;flex-shrink:0;");
    head.append(el("span", "font-size:12px;font-weight:bold;color:#aaa;flex:1;", "API 設定"));

    const body = el("div", "flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;");

    const sectionTitle = el("div", "font-size:11px;font-weight:bold;color:#8fd;", "Lemonade（音声作成 / Kokoro）");
    const inputStyle = "width:100%;box-sizing:border-box;background:#111;border:1px solid #444;color:#ddd;" +
                       "padding:4px 7px;border-radius:4px;font-size:12px;";
    const baseUrl = el("input", inputStyle);
    baseUrl.placeholder = "http://127.0.0.1:13305";
    const model = el("input", inputStyle);
    model.placeholder = "kokoro-v1";

    // Lemonade（Kokoro）で動作を確認済みの声。一覧を返す API が無いため、ここに固定で並べる
    const VOICES = ["jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "af_heart", "af_bella", "bf_emma"];
    const voice = el("select", inputStyle);
    const setVoiceOptions = (current) => {
        const names = VOICES.includes(current) || !current ? VOICES : [current, ...VOICES];
        voice.replaceChildren(...names.map(v => {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = v + (v.startsWith("j") ? "（日本語）" : v.startsWith("a") || v.startsWith("b") ? "（英語）" : "");
            return opt;
        }));
        voice.value = current || VOICES[0];
    };
    setVoiceOptions("");

    const field = (label, input) => {
        const wrap = el("div", "display:flex;flex-direction:column;gap:3px;");
        wrap.append(el("div", "font-size:11px;color:#aaa;", label), input);
        return wrap;
    };

    const btnRow = el("div", "display:flex;gap:6px;flex-wrap:wrap;");
    const saveBtn = smallBtn("保存", "#3a6a1a", "API 設定を保存する");
    const testBtn = smallBtn("接続テスト", "#333344", "Lemonade の /api/v1/health に接続する");
    btnRow.append(saveBtn, testBtn);

    const status = el("div", "font-size:11px;color:#888;white-space:pre-wrap;word-break:break-all;");
    const note = el("div", "font-size:10px;color:#666;",
                    "保存先: output/vrm_pose_editor/api_settings.json（ComfyUI の output フォルダ）");

    body.append(sectionTitle, field("Base URL", baseUrl), field("Model", model),
                field("Voice（既定の声）", voice), btnRow, status, note);
    root.append(head, body);

    function fill(cfg) {
        baseUrl.value = cfg.base_url ?? "";
        model.value = cfg.model ?? "";
        setVoiceOptions(cfg.voice ?? "");
    }

    async function load() {
        try {
            const res = await fetchApi("/pose_editor/tts/settings");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            fill(data.settings.lemonade);
            status.textContent = "";
        } catch (e) {
            status.textContent = `設定を読み込めませんでした: ${e.message}`;
        }
    }

    saveBtn.onclick = async () => {
        status.textContent = "保存中…";
        try {
            const res = await fetchApi("/pose_editor/tts/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    lemonade: { base_url: baseUrl.value, model: model.value, voice: voice.value },
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
            fill(data.settings.lemonade);
            status.textContent = "保存しました。";
        } catch (e) {
            status.textContent = `保存できませんでした: ${e.message}`;
        }
    };

    testBtn.onclick = async () => {
        status.textContent = "接続テスト中…";
        try {
            const res = await fetchApi("/pose_editor/tts/health");
            const data = await res.json();
            status.textContent = data.ok
                ? `接続OK（${data.status}）`
                : `接続できませんでした: ${data.error}`;
        } catch (e) {
            status.textContent = `接続テストに失敗: ${e.message}`;
        }
    };

    return { el: root, refresh: load };
}
