"""
Default Model Server
- <node_dir>/model/ に置かれたモデル(.vrm / .glb / .gltf)の一覧取得
- モデルファイルの配信(.gltf の外部リソースが相対パスで解決できるよう、パス形式の URL で配信する)

どのモデルを既定にするかの設定は、フロント側が ComfyUI のユーザーデータ(/userdata)に保存する。
"""

import re
from pathlib import Path

import server
web = server.web

_NODE_DIR = Path(__file__).parent.resolve()
MODEL_DIR = _NODE_DIR / "model"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

MODEL_EXTS = (".vrm", ".glb", ".gltf")

_DRIVE_RE = re.compile(r"^[A-Za-z]:")


def _is_safe_rel(rel) -> bool:
    """URL から受け取った相対パスを、結合・resolve() の前に文字列のまま検査する。

    Windows では UNC パス(\\\\host\\share)は resolve() した時点で相手ホストへ
    Windows アカウントの資格情報付きで接続してしまうため、UNC・ドライブ指定・
    絶対パス・「..」をパス操作より先に拒否する。"""
    s = str(rel or "")
    if not s or "\x00" in s:
        return False
    if s.startswith(("/", "\\")) or _DRIVE_RE.match(s):
        return False
    return not any(part in ("", "..") for part in re.split(r"[/\\]", s))


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
    rel = request.match_info["path"]
    # セキュリティ: model/ 配下のみ。UNC・ドライブ指定・絶対パス・「..」は
    # 結合・resolve() の前に文字列のまま拒否する
    if not _is_safe_rel(rel):
        return web.json_response({"error": "access denied"}, status=403)
    target = (MODEL_DIR / rel).resolve()
    try:
        target.relative_to(MODEL_DIR)
    except ValueError:
        return web.json_response({"error": "access denied"}, status=403)
    if not target.is_file():
        return web.Response(status=404)
    return web.FileResponse(target)
