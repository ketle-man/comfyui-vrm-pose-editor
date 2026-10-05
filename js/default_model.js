// default_model.js — 既定モデル(ノード作成時・ページ読み込み時に自動で読み込むモデル)の設定
//
// ・モデルはユーザーが <node_dir>/model/ に置く(.vrm / .glb / .gltf、ファイル名は自由)
// ・どれを既定にするかは ComfyUI のユーザーデータ(user/<user>/vrm_pose_editor_settings.json)に保存する。
//   ノードを更新・再インストールしても消えない
// ・設定値 defaultModel: "" = 自動(model/ の先頭のファイル) / NONE_MODEL = 読み込まない / それ以外 = ファイル名
// ・モデルは同梱しない。model/ が空ならモデル無しで起動する

import { fetchApi, apiURL } from "./comfy_api.js";

export const NONE_MODEL = "__none__";
const SETTINGS_FILE = "vrm_pose_editor_settings.json";

let _settingsCache = null;

export async function loadEditorSettings() {
    if (_settingsCache) return _settingsCache;
    try {
        const res = await fetchApi(`/userdata/${encodeURIComponent(SETTINGS_FILE)}`);
        _settingsCache = res.ok ? await res.json() : {};
    } catch {
        _settingsCache = {};
    }
    return _settingsCache;
}

export async function saveEditorSettings(patch) {
    const next = { ...(await loadEditorSettings()), ...patch };
    const res = await fetchApi(`/userdata/${encodeURIComponent(SETTINGS_FILE)}?overwrite=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next, null, 2),
    });
    if (!res.ok) throw new Error(`設定を保存できませんでした (HTTP ${res.status})`);
    _settingsCache = next;
    return next;
}

// { models: [{ name, ext, size }], dir }
export async function listModels() {
    const res = await fetchApi("/pose_editor/models");
    if (!res.ok) throw new Error(`モデル一覧を取得できませんでした (HTTP ${res.status})`);
    return res.json();
}

export function modelUrl(name) {
    return apiURL(`/pose_editor/models/${encodeURIComponent(name)}`);
}

// 既定モデルを決める。戻り値: { name, url } / null(読み込まない・model/ が空・取得失敗)
export async function resolveDefaultModel() {
    let list, settings;
    try {
        [list, settings] = await Promise.all([listModels(), loadEditorSettings()]);
    } catch (e) {
        console.warn("[PoseEditor3D] default model lookup failed:", e);
        return null;
    }
    const sel = settings.defaultModel ?? "";
    if (sel === NONE_MODEL) return null;
    // 選んだファイルが消えていたら自動(先頭)にフォールバックする
    const pick = list.models.find(m => m.name === sel) ?? list.models[0];
    return pick ? { name: pick.name, url: modelUrl(pick.name) } : null;
}
