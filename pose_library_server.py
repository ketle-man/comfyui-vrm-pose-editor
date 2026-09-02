"""
Pose Library Server
- ポーズファイル（.json / .vroidpose）の一覧取得（固定フォルダ: <node_dir>/poses/）
- サブディレクトリ一覧取得
- サムネイル画像の保存・取得
- お気に入り・メモのメタデータ管理
- ポーズJSON保存（poses/ 固定、p_時分秒 形式）
- ファイル名変更
"""

import os
import json
import hashlib
import base64
from datetime import datetime
from pathlib import Path

import server
web = server.web

# ----------------------------------------------------------------
# パス定義
# ----------------------------------------------------------------
_NODE_DIR  = Path(__file__).parent.resolve()
POSES_DIR  = _NODE_DIR / "poses"
POSES_DIR.mkdir(parents=True, exist_ok=True)

_STORE_DIR = _NODE_DIR / ".pose_library"
_STORE_DIR.mkdir(parents=True, exist_ok=True)

_META_FILE = _STORE_DIR / "metadata.json"
_THUMB_DIR = _STORE_DIR / "thumbnails"
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
# API: ポーズ一覧
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/pose_library/list")
async def list_poses(request):
    """
    GET /pose_library/list[?subdir=<name>]
    poses/ (またはサブディレクトリ) の .json/.vroidpose/.vrma 一覧を返す。
    サブディレクトリは再帰スキャンせず1階層のみ。
    """
    subdir = request.rel_url.query.get("subdir", "")
    if subdir:
        target = POSES_DIR / subdir
        try:
            target.resolve().relative_to(POSES_DIR.resolve())
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
    else:
        target = POSES_DIR

    if not target.exists() or not target.is_dir():
        return web.json_response({"error": f"Directory not found: {target}"}, status=404)

    meta  = _load_meta()
    poses = []

    # subdir 指定なし（すべて）は再帰スキャン、指定ありは1階層のみ
    scan = target.rglob if not subdir else target.glob

    for ext in ("*.json", "*.vroidpose", "*.vrma"):
        for p in sorted(scan(ext)):
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
                "memo":     m.get("memo", ""),
                "thumb":    thumb_url,
            })

    return web.json_response({
        "poses":     poses,
        "poses_dir": str(target),
    })


# ----------------------------------------------------------------
# API: サブディレクトリ一覧
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/pose_library/subdirs")
async def list_subdirs(request):
    """GET /pose_library/subdirs  — poses/ 直下のサブディレクトリ名一覧"""
    dirs = sorted(
        d.name for d in POSES_DIR.iterdir()
        if d.is_dir() and not d.name.startswith(".")
    )
    return web.json_response({"subdirs": dirs})


# ----------------------------------------------------------------
# API: サムネイル
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/pose_library/thumbnail/{file_id}")
async def get_thumbnail(request):
    fid        = request.match_info["file_id"]
    thumb_file = _THUMB_DIR / f"{fid}.png"
    if not thumb_file.exists():
        return web.Response(status=404)
    return web.Response(body=thumb_file.read_bytes(), content_type="image/png")


@server.PromptServer.instance.routes.post("/pose_library/thumbnail/{file_id}")
async def save_thumbnail(request):
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


# ----------------------------------------------------------------
# API: メタデータ更新
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/pose_library/meta")
async def update_meta(request):
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    fid = body.get("id")
    if not fid:
        return web.json_response({"error": "id required"}, status=400)

    meta  = _load_meta()
    entry = meta.setdefault(fid, {})
    for key in ("favorite", "memo"):
        if key in body:
            entry[key] = body[key]
    _save_meta(meta)
    return web.json_response({"ok": True})


# ----------------------------------------------------------------
# API: ポーズファイル内容取得
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/pose_library/content")
async def get_pose_content(request):
    filepath = request.rel_url.query.get("path", "")
    if not filepath:
        return web.json_response({"error": "path required"}, status=400)
    p = Path(filepath)
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


# ----------------------------------------------------------------
# API: VRMAファイル内容取得(バイナリ)
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/pose_library/vrma_content")
async def get_vrma_content(request):
    """GET /pose_library/vrma_content?path=... — .vrma(glbバイナリ)をそのまま返す"""
    filepath = request.rel_url.query.get("path", "")
    if not filepath:
        return web.json_response({"error": "path required"}, status=400)
    p = Path(filepath)
    try:
        p.resolve().relative_to(POSES_DIR.resolve())
    except ValueError:
        return web.json_response({"error": "access denied"}, status=403)
    if not p.exists():
        return web.json_response({"error": "file not found"}, status=404)
    try:
        data = p.read_bytes()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    return web.Response(body=data, content_type="model/gltf-binary")


# ----------------------------------------------------------------
# API: ポーズJSON保存
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/pose_library/save_pose")
async def save_pose(request):
    """
    POST /pose_library/save_pose
    body: { "json": "<pose json string>", "subdir": "<optional subdir>" }
    poses/ (またはサブディレクトリ) に p_HHMMSS.json で保存。
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    pose_json = body.get("json", "")
    if not pose_json:
        return web.json_response({"error": "json required"}, status=400)

    subdir = body.get("subdir", "")
    if subdir:
        save_dir = POSES_DIR / subdir
        try:
            save_dir.resolve().relative_to(POSES_DIR.resolve())
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        save_dir.mkdir(parents=True, exist_ok=True)
    else:
        save_dir = POSES_DIR

    ts       = datetime.now().strftime("%H%M%S")
    filename = f"p_{ts}.json"
    # 同名衝突回避
    dest = save_dir / filename
    if dest.exists():
        dest = save_dir / f"p_{ts}_{int(datetime.now().microsecond / 1000):03d}.json"

    dest.write_text(pose_json, encoding="utf-8")
    return web.json_response({"ok": True, "path": str(dest), "name": dest.stem})


# ----------------------------------------------------------------
# API: VRMA保存(バイナリ、base64)
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/pose_library/save_vrma")
async def save_vrma(request):
    """
    POST /pose_library/save_vrma
    body: { "data": "<base64 glb>", "subdir": "<optional subdir>" }
    poses/ (またはサブディレクトリ) に v_HHMMSS.vrma で保存。
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    b64 = body.get("data", "")
    if not b64:
        return web.json_response({"error": "data required"}, status=400)
    try:
        vrma_bytes = base64.b64decode(b64)
    except Exception as e:
        return web.json_response({"error": f"invalid base64: {e}"}, status=400)

    subdir = body.get("subdir", "")
    if subdir:
        save_dir = POSES_DIR / subdir
        try:
            save_dir.resolve().relative_to(POSES_DIR.resolve())
        except ValueError:
            return web.json_response({"error": "access denied"}, status=403)
        save_dir.mkdir(parents=True, exist_ok=True)
    else:
        save_dir = POSES_DIR

    ts       = datetime.now().strftime("%H%M%S")
    filename = f"v_{ts}.vrma"
    # 同名衝突回避
    dest = save_dir / filename
    if dest.exists():
        dest = save_dir / f"v_{ts}_{int(datetime.now().microsecond / 1000):03d}.vrma"

    dest.write_bytes(vrma_bytes)
    return web.json_response({"ok": True, "path": str(dest), "name": dest.stem})


# ----------------------------------------------------------------
# API: ファイル名変更
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/pose_library/rename")
async def rename_pose(request):
    """
    POST /pose_library/rename
    body: { "path": "<current path>", "new_name": "<stem without ext>" }
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    old_path = Path(body.get("path", ""))
    new_stem = body.get("new_name", "").strip()

    if not new_stem:
        return web.json_response({"error": "new_name required"}, status=400)

    # セキュリティ: poses/ 配下のみ
    try:
        old_path.resolve().relative_to(POSES_DIR.resolve())
    except ValueError:
        return web.json_response({"error": "access denied"}, status=403)

    if not old_path.exists():
        return web.json_response({"error": "file not found"}, status=404)

    # ファイル名に使えない文字を除去
    safe_stem = "".join(c for c in new_stem if c not in r'\/:*?"<>|')
    if not safe_stem:
        return web.json_response({"error": "invalid name"}, status=400)

    new_path = old_path.parent / (safe_stem + old_path.suffix)
    if new_path.exists() and new_path != old_path:
        return web.json_response({"error": "name already exists"}, status=409)

    # メタデータのキーを移行
    meta    = _load_meta()
    old_fid = _file_id(str(old_path))
    old_meta = meta.pop(old_fid, {})

    old_path.rename(new_path)

    # サムネイルも移行
    old_thumb = _THUMB_DIR / f"{old_fid}.png"
    new_fid   = _file_id(str(new_path))
    if old_thumb.exists():
        old_thumb.rename(_THUMB_DIR / f"{new_fid}.png")

    if old_meta:
        meta[new_fid] = old_meta
    _save_meta(meta)

    return web.json_response({
        "ok":       True,
        "path":     str(new_path),
        "new_id":   new_fid,
        "new_name": new_path.stem,
        "has_thumb": (_THUMB_DIR / f"{new_fid}.png").exists(),
    })


# ================================================================
# Light Library API
# ライト設定プリセットを .light_library/ フォルダに保存・管理する
# ================================================================

_LIGHT_LIB_DIR = _NODE_DIR / ".light_library"
_LIGHT_LIB_DIR.mkdir(parents=True, exist_ok=True)


def _light_preset_id(filepath: str) -> str:
    return hashlib.md5(filepath.encode("utf-8")).hexdigest()


# ----------------------------------------------------------------
# API: プリセット一覧取得
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/light_library/list")
async def light_library_list(request):
    """GET /light_library/list  — プリセット一覧を返す"""
    presets = []
    for p in sorted(_LIGHT_LIB_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        pid = _light_preset_id(str(p))
        presets.append({
            "id":        pid,
            "path":      str(p),
            "name":      data.get("name", p.stem),
            "createdAt": data.get("createdAt", ""),
        })
    return web.json_response({"presets": presets})


# ----------------------------------------------------------------
# API: プリセット保存
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/light_library/save")
async def light_library_save(request):
    """
    POST /light_library/save
    body: { "name": "<preset name>", "preset": { ...light settings... } }
    .light_library/ に l_HHMMSS.json で保存。
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    name   = body.get("name", "").strip()
    preset = body.get("preset")
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    if preset is None:
        return web.json_response({"error": "preset required"}, status=400)

    ts       = datetime.now().strftime("%H%M%S")
    filename = f"l_{ts}.json"
    dest     = _LIGHT_LIB_DIR / filename
    # 同名衝突回避
    if dest.exists():
        dest = _LIGHT_LIB_DIR / f"l_{ts}_{int(datetime.now().microsecond / 1000):03d}.json"

    data = {
        "version":   1,
        "name":      name,
        "createdAt": datetime.utcnow().isoformat() + "Z",
        **preset,
    }
    dest.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    pid = _light_preset_id(str(dest))
    return web.json_response({
        "ok":        True,
        "id":        pid,
        "path":      str(dest),
        "name":      name,
        "createdAt": data["createdAt"],
    })


# ----------------------------------------------------------------
# API: プリセット内容取得
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/light_library/get/{preset_id}")
async def light_library_get(request):
    """GET /light_library/get/{preset_id}  — プリセット内容を返す"""
    pid = request.match_info["preset_id"]
    # preset_id から対応ファイルを検索
    for p in _LIGHT_LIB_DIR.glob("*.json"):
        if _light_preset_id(str(p)) == pid:
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                return web.json_response(data)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"error": "not found"}, status=404)


# ----------------------------------------------------------------
# API: プリセット名変更
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/light_library/rename")
async def light_library_rename(request):
    """
    POST /light_library/rename
    body: { "id": "<preset_id>", "new_name": "<new display name>" }
    ファイル名は変更せず、JSON 内の name フィールドのみ更新。
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    pid      = body.get("id", "")
    new_name = body.get("new_name", "").strip()
    if not pid:
        return web.json_response({"error": "id required"}, status=400)
    if not new_name:
        return web.json_response({"error": "new_name required"}, status=400)

    for p in _LIGHT_LIB_DIR.glob("*.json"):
        if _light_preset_id(str(p)) == pid:
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                data["name"] = new_name
                p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                return web.json_response({"ok": True, "id": pid, "name": new_name})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"error": "not found"}, status=404)


# ----------------------------------------------------------------
# API: プリセット削除
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/light_library/delete")
async def light_library_delete(request):
    """
    POST /light_library/delete
    body: { "id": "<preset_id>" }
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    pid = body.get("id", "")
    if not pid:
        return web.json_response({"error": "id required"}, status=400)

    for p in _LIGHT_LIB_DIR.glob("*.json"):
        if _light_preset_id(str(p)) == pid:
            try:
                p.unlink()
                return web.json_response({"ok": True})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"error": "not found"}, status=404)


# ================================================================
# Keyframe Project Library API
# キーフレームタイムライン全体(ポーズKF+カメラKF+fps+総フレーム数)を .kf_projects/ フォルダに
# 保存・管理する。Light Library APIと完全に同じパターン。
# ================================================================

_KF_PROJECT_DIR = _NODE_DIR / ".kf_projects"
_KF_PROJECT_DIR.mkdir(parents=True, exist_ok=True)


def _kf_project_id(filepath: str) -> str:
    return hashlib.md5(filepath.encode("utf-8")).hexdigest()


# ----------------------------------------------------------------
# API: プロジェクト一覧取得
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/kf_project/list")
async def kf_project_list(request):
    """GET /kf_project/list  — プロジェクト一覧を返す"""
    projects = []
    for p in sorted(_KF_PROJECT_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        pid = _kf_project_id(str(p))
        kfs = data.get("keyframes", [])
        projects.append({
            "id":          pid,
            "path":        str(p),
            "name":        data.get("name", p.stem),
            "createdAt":   data.get("createdAt", ""),
            "fps":         data.get("fps", 24),
            "totalFrames": data.get("totalFrames", 60),
            "keyframeCount": len(kfs),
        })
    return web.json_response({"projects": projects})


# ----------------------------------------------------------------
# API: プロジェクト保存
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/kf_project/save")
async def kf_project_save(request):
    """
    POST /kf_project/save
    body: { "name": "<project name>", "project": { fps, totalFrames, keyframes: [...] } }
    .kf_projects/ に kp_HHMMSS.json で保存。
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    name    = body.get("name", "").strip()
    project = body.get("project")
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    if project is None:
        return web.json_response({"error": "project required"}, status=400)

    ts       = datetime.now().strftime("%H%M%S")
    filename = f"kp_{ts}.json"
    dest     = _KF_PROJECT_DIR / filename
    # 同名衝突回避
    if dest.exists():
        dest = _KF_PROJECT_DIR / f"kp_{ts}_{int(datetime.now().microsecond / 1000):03d}.json"

    data = {
        "version":   1,
        "name":      name,
        "createdAt": datetime.utcnow().isoformat() + "Z",
        **project,
    }
    dest.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    pid = _kf_project_id(str(dest))
    return web.json_response({
        "ok":        True,
        "id":        pid,
        "path":      str(dest),
        "name":      name,
        "createdAt": data["createdAt"],
    })


# ----------------------------------------------------------------
# API: プロジェクト内容取得
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.get("/kf_project/get/{project_id}")
async def kf_project_get(request):
    """GET /kf_project/get/{project_id}  — プロジェクト内容を返す"""
    pid = request.match_info["project_id"]
    for p in _KF_PROJECT_DIR.glob("*.json"):
        if _kf_project_id(str(p)) == pid:
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                return web.json_response(data)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"error": "not found"}, status=404)


# ----------------------------------------------------------------
# API: プロジェクト名変更
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/kf_project/rename")
async def kf_project_rename(request):
    """
    POST /kf_project/rename
    body: { "id": "<project_id>", "new_name": "<new display name>" }
    ファイル名は変更せず、JSON内のnameフィールドのみ更新。
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    pid      = body.get("id", "")
    new_name = body.get("new_name", "").strip()
    if not pid:
        return web.json_response({"error": "id required"}, status=400)
    if not new_name:
        return web.json_response({"error": "new_name required"}, status=400)

    for p in _KF_PROJECT_DIR.glob("*.json"):
        if _kf_project_id(str(p)) == pid:
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                data["name"] = new_name
                p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                return web.json_response({"ok": True, "id": pid, "name": new_name})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"error": "not found"}, status=404)


# ----------------------------------------------------------------
# API: プロジェクト削除
# ----------------------------------------------------------------

@server.PromptServer.instance.routes.post("/kf_project/delete")
async def kf_project_delete(request):
    """
    POST /kf_project/delete
    body: { "id": "<project_id>" }
    """
    try:
        body = await request.json()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    pid = body.get("id", "")
    if not pid:
        return web.json_response({"error": "id required"}, status=400)

    for p in _KF_PROJECT_DIR.glob("*.json"):
        if _kf_project_id(str(p)) == pid:
            try:
                p.unlink()
                return web.json_response({"ok": True})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"error": "not found"}, status=404)
