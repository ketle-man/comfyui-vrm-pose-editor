"""
Pose Library Server
- ポーズファイル（.json / .vroidpose）の一覧取得（固定フォルダ: <node_dir>/poses/）
- サムネイル画像の保存・取得
- お気に入り・グループ・メモのメタデータ管理

ComfyUI の正しいルート登録方式:
  @PromptServer.instance.routes.get("/pose_library/...")
"""

import os
import json
import hashlib
import base64
from pathlib import Path

import server
web = server.web

# ----------------------------------------------------------------
# ノード固有のフォルダパス
# ----------------------------------------------------------------

# このファイルが置かれているカスタムノードのルート
_NODE_DIR = Path(__file__).parent.resolve()

# ポーズファイルを置く固定フォルダ
POSES_DIR = _NODE_DIR / "poses"
POSES_DIR.mkdir(parents=True, exist_ok=True)

# メタデータ・サムネイルのストレージ
_STORE_DIR = _NODE_DIR / ".pose_library"
_STORE_DIR.mkdir(parents=True, exist_ok=True)

_META_FILE  = _STORE_DIR / "metadata.json"
_THUMB_DIR  = _STORE_DIR / "thumbnails"
_THUMB_DIR.mkdir(parents=True, exist_ok=True)


# ----------------------------------------------------------------
# メタデータ管理
# ----------------------------------------------------------------

def _load_meta() -> dict:
    if _META_FILE.exists():
        try:
            return json.loads(_META_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_meta(meta: dict):
    _META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _file_id(filepath: str) -> str:
    return hashlib.md5(filepath.encode("utf-8")).hexdigest()


# ----------------------------------------------------------------
# API ハンドラー
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/pose_library/list")
async def list_poses(request):
    """
    GET /pose_library/list
    POSES_DIR（固定）を再帰スキャンして .json/.vroidpose の一覧を返す。
    """
    meta  = _load_meta()
    poses = []

    for ext in ("*.json", "*.vroidpose"):
        for p in sorted(POSES_DIR.rglob(ext)):
            fid = _file_id(str(p))
            m   = meta.get(fid, {})
            thumb_file = _THUMB_DIR / f"{fid}.png"
            thumb_url  = f"/pose_library/thumbnail/{fid}" if thumb_file.exists() else None

            poses.append({
                "id":       fid,
                "path":     str(p),
                "name":     p.stem,
                "ext":      p.suffix.lower(),
                "favorite": m.get("favorite", False),
                "group":    m.get("group", ""),
                "memo":     m.get("memo", ""),
                "thumb":    thumb_url,
            })

    return web.json_response({"poses": poses, "poses_dir": str(POSES_DIR)})


@server.PromptServer.instance.routes.get("/pose_library/thumbnail/{file_id}")
async def get_thumbnail(request):
    """GET /pose_library/thumbnail/<file_id> — 保存済みサムネイルPNGを返す"""
    fid        = request.match_info["file_id"]
    thumb_file = _THUMB_DIR / f"{fid}.png"
    if not thumb_file.exists():
        return web.Response(status=404)
    return web.Response(body=thumb_file.read_bytes(), content_type="image/png")


@server.PromptServer.instance.routes.post("/pose_library/thumbnail/{file_id}")
async def save_thumbnail(request):
    """POST /pose_library/thumbnail/<file_id>  body: { "image": "<base64 PNG>" }"""
    fid = request.match_info["file_id"]
    try:
        body     = await request.json()
        img_data = body.get("image", "")
        if "," in img_data:
            img_data = img_data.split(",", 1)[1]
        png_bytes = base64.b64decode(img_data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    (_THUMB_DIR / f"{fid}.png").write_bytes(png_bytes)
    return web.json_response({"ok": True, "url": f"/pose_library/thumbnail/{fid}"})


@server.PromptServer.instance.routes.post("/pose_library/meta")
async def update_meta(request):
    """POST /pose_library/meta  body: { "id", "favorite"?, "group"?, "memo"? }"""
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    fid = body.get("id")
    if not fid:
        return web.json_response({"error": "id required"}, status=400)

    meta  = _load_meta()
    entry = meta.setdefault(fid, {})
    for key in ("favorite", "group", "memo"):
        if key in body:
            entry[key] = body[key]
    _save_meta(meta)
    return web.json_response({"ok": True})


@server.PromptServer.instance.routes.get("/pose_library/content")
async def get_pose_content(request):
    """GET /pose_library/content?path=<filepath> — ポーズファイル内容を返す"""
    filepath = request.rel_url.query.get("path", "")
    if not filepath:
        return web.json_response({"error": "path required"}, status=400)

    p = Path(filepath)

    # セキュリティ: POSES_DIR 配下のみ許可
    try:
        p.resolve().relative_to(POSES_DIR.resolve())
    except ValueError:
        return web.json_response({"error": "access denied"}, status=403)

    if not p.exists():
        return web.json_response({"error": "file not found"}, status=404)

    try:
        content = p.read_text(encoding="utf-8")
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    return web.Response(text=content, content_type="application/json")
