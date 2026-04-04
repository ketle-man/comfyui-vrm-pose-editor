"""
Pose Library Server
- ポーズファイル（.json / .vroidpose）の一覧取得
- サムネイル画像の保存・取得
- お気に入り・グループ・メモのメタデータ管理
"""

import os
import json
import glob
import hashlib
import base64
import mimetypes
from pathlib import Path
from aiohttp import web


# -----------------------------------------------------------------
# メタデータDB（JSONファイルで永続化）
# -----------------------------------------------------------------

def _meta_path() -> Path:
    """メタデータファイルのパスを返す（ユーザーホームの .comfyui_pose_library フォルダ）"""
    base = Path(os.environ.get("COMFYUI_POSE_LIBRARY_META",
                               Path.home() / ".comfyui_pose_library"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "metadata.json"


def _load_meta() -> dict:
    p = _meta_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_meta(meta: dict):
    _meta_path().write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _thumb_dir() -> Path:
    base = _meta_path().parent / "thumbnails"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _file_id(filepath: str) -> str:
    """ファイルパスからユニークIDを生成"""
    return hashlib.md5(filepath.encode("utf-8")).hexdigest()


# -----------------------------------------------------------------
# API ハンドラー
# -----------------------------------------------------------------

async def list_poses(request: web.Request) -> web.Response:
    """
    GET /pose_library/list?dir=<directory>
    指定ディレクトリ（再帰）の .json/.vroidpose ファイル一覧を返す。
    各エントリにメタデータ（お気に入り・グループ・メモ・サムネイルURL）を付加する。
    """
    directory = request.rel_url.query.get("dir", "")
    if not directory:
        return web.json_response({"error": "dir parameter is required"}, status=400)

    dir_path = Path(directory)
    if not dir_path.exists() or not dir_path.is_dir():
        return web.json_response({"error": f"Directory not found: {directory}"}, status=404)

    meta = _load_meta()
    poses = []

    for ext in ("*.json", "*.vroidpose"):
        for p in sorted(dir_path.rglob(ext)):
            fid = _file_id(str(p))
            m = meta.get(fid, {})
            # サムネイルがあればURLを付加
            thumb_file = _thumb_dir() / f"{fid}.png"
            thumb_url = f"/pose_library/thumbnail/{fid}" if thumb_file.exists() else None

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

    return web.json_response({"poses": poses})


async def get_thumbnail(request: web.Request) -> web.Response:
    """
    GET /pose_library/thumbnail/<file_id>
    保存済みサムネイルPNGを返す。
    """
    fid = request.match_info.get("file_id", "")
    thumb_file = _thumb_dir() / f"{fid}.png"
    if not thumb_file.exists():
        return web.Response(status=404)
    data = thumb_file.read_bytes()
    return web.Response(body=data, content_type="image/png")


async def save_thumbnail(request: web.Request) -> web.Response:
    """
    POST /pose_library/thumbnail/<file_id>
    body: { "image": "<base64 PNG>" }
    サムネイルをPNGファイルとして保存する。
    """
    fid = request.match_info.get("file_id", "")
    if not fid:
        return web.json_response({"error": "file_id required"}, status=400)
    try:
        body = await request.json()
        img_data = body.get("image", "")
        if "," in img_data:
            img_data = img_data.split(",", 1)[1]
        png_bytes = base64.b64decode(img_data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    thumb_file = _thumb_dir() / f"{fid}.png"
    thumb_file.write_bytes(png_bytes)
    return web.json_response({"ok": True, "url": f"/pose_library/thumbnail/{fid}"})


async def update_meta(request: web.Request) -> web.Response:
    """
    POST /pose_library/meta
    body: { "id": "<file_id>", "favorite": bool, "group": str, "memo": str }
    メタデータを更新する。指定されたフィールドのみ上書き。
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    fid = body.get("id")
    if not fid:
        return web.json_response({"error": "id required"}, status=400)

    meta = _load_meta()
    entry = meta.setdefault(fid, {})

    for key in ("favorite", "group", "memo"):
        if key in body:
            entry[key] = body[key]

    _save_meta(meta)
    return web.json_response({"ok": True})


async def get_pose_content(request: web.Request) -> web.Response:
    """
    GET /pose_library/content?path=<filepath>
    ポーズファイルの中身（JSON / vroidpose）をテキストで返す。
    """
    filepath = request.rel_url.query.get("path", "")
    if not filepath:
        return web.json_response({"error": "path required"}, status=400)
    p = Path(filepath)
    if not p.exists():
        return web.json_response({"error": "file not found"}, status=404)
    try:
        content = p.read_text(encoding="utf-8")
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    return web.Response(text=content, content_type="application/json")


# -----------------------------------------------------------------
# ルート登録
# -----------------------------------------------------------------

def register_routes(app):
    app.router.add_get( "/pose_library/list",              list_poses)
    app.router.add_get( "/pose_library/thumbnail/{file_id}", get_thumbnail)
    app.router.add_post("/pose_library/thumbnail/{file_id}", save_thumbnail)
    app.router.add_post("/pose_library/meta",              update_meta)
    app.router.add_get( "/pose_library/content",           get_pose_content)
