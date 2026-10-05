// comfy_api.js — ComfyUI の HTTP API を呼ぶための薄いラッパー
//
// light_editor.js 以下のモジュールは、ComfyUI 本体の画面(ノード)だけでなく、Comic Creator などの
// 同じ ComfyUI サーバー上の単独ページからも動的 import される。"../../scripts/api.js" は
// window.comfyAPI を参照するだけのシムで、ComfyUI 本体の画面以外では import した時点でエラーになり、
// 読み込み元のモジュールごと使えなくなる。そのため静的 import はせず、呼び出し時に判定する:
//   ・ComfyUI 本体の画面: window.comfyAPI.api.api(認証ヘッダー・api_base 等を本体に任せる)
//   ・それ以外の同一オリジンのページ: fetch("/api" + route)(ComfyUI はすべてのルートを /api 付きでも公開する)

function comfyApi() {
    return window.comfyAPI?.api?.api ?? null;
}

export function fetchApi(route, init) {
    const api = comfyApi();
    return api ? api.fetchApi(route, init) : fetch(`/api${route}`, init);
}

export function apiURL(route) {
    const api = comfyApi();
    return api ? api.apiURL(route) : `/api${route}`;
}

// /prompt に添える client_id(ComfyUI 本体の画面以外では無し。実行結果は /history で取得するので不要)
export function clientId() {
    return comfyApi()?.clientId;
}
