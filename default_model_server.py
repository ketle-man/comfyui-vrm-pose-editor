"""
Default Model Server
- <node_dir>/model/ に置かれたモデル(.vrm / .glb / .gltf)の一覧取得
- モデルファイルの配信(.gltf の外部リソースが相対パスで解決できるよう、パス形式の URL で配信する)

どのモデルを既定にするかの設定は、フロント側が ComfyUI のユーザーデータ(/userdata)に保存する。
"""

from pathlib import Path

import server
web = server.web

_NODE_DIR = Path(__file__).parent.resolve()
MODEL_DIR = _NODE_DIR / "model"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

MODEL_EXTS = (".vrm", ".glb", ".gltf")


@server.PromptServer.instance.routes.get("/pose_editor/models")
async def list_models(request):
    """GET /pose_editor/models — model/ 直下のモデル一覧(名前順)"""
    models = [
        {"name": p.name, "ext": p.suffix.lower(), "size": p.stat().st_size}
        for p in sorted(MODEL_DIR.iterdir(), key=lambda p: p.name.lower())
        if p.is_file() and p.suffix.lower() in MODEL_EXTS
    ]
    return web.json_response({"models": models, "dir": str(MODEL_DIR)})


@server.PromptServer.instance.routes.get("/pose_editor/models/{path:.+}")
async def get_model_file(request):
    """GET /pose_editor/models/<path> — model/ 配下のファイルを返す(.gltf の .bin / テクスチャ含む)"""
    target = (MODEL_DIR / request.match_info["path"]).resolve()
    # セキュリティ: model/ 配下のみ
    try:
        target.relative_to(MODEL_DIR)
    except ValueError:
        return web.json_response({"error": "access denied"}, status=403)
    if not target.is_file():
        return web.Response(status=404)
    return web.FileResponse(target)
