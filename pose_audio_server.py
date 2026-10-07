"""
Pose Audio Server
- 音声ファイルの管理: <output>/vrm_pose_editor/Audio の一覧・配信・削除(A タブ)
- テキストから音声を作成: Lemonade の OpenAI 互換 /api/v1/audio/speech を呼び、Audio フォルダへ保存
- API 設定: <output>/vrm_pose_editor/api_settings.json に保存(S タブ)

ファイル名は英数字・_・- と .mp3/.wav に限定し、Audio フォルダの外を指せないようにする。
"""

import asyncio
import http.client
import ipaddress
import json
import logging
import re
import urllib.parse
from datetime import datetime
from pathlib import Path

import folder_paths
import server
web = server.web

ROUTES = server.PromptServer.instance.routes
log = logging.getLogger("pose_audio_server")

NAME_RE = re.compile(r"^[A-Za-z0-9_\-]{1,120}\.(mp3|wav)$")
MAX_TEXT_LEN = 2000
MAX_SETTING_LEN = 200
DEFAULT_LEMONADE = {"base_url": "http://127.0.0.1:13305", "model": "kokoro-v1", "voice": "jf_alpha"}


def _out_root() -> Path:
    return Path(folder_paths.get_output_directory()) / "vrm_pose_editor"


def _audio_dir() -> Path:
    d = _out_root() / "Audio"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _settings_path() -> Path:
    _out_root().mkdir(parents=True, exist_ok=True)
    return _out_root() / "api_settings.json"


def _audio_path(name: str):
    """名前が規則に合い、Audio フォルダ直下に実在するファイルだけ返す。それ以外は None"""
    if not NAME_RE.match(name or ""):
        return None
    p = _audio_dir() / name
    return p if p.is_file() else None


def _base_url_error(url: str):
    """接続先 URL の検証。問題なければ None、あれば理由の文字列を返す。
    Lemonade はこの PC で動かす前提のため、接続先はループバック(localhost / 127.0.0.1 / ::1)だけに限る。
    サーバーが任意の URL へ通信しない(SSRF 対策)ように、ユーザー情報・クエリ・フラグメントも拒否する。"""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return "base_url は http:// か https:// で始めてください"
    if parts.username or parts.password or parts.query or parts.fragment:
        return "base_url にユーザー情報・クエリ・フラグメントは含められません"
    host = parts.hostname or ""
    if host.lower() == "localhost":
        return None
    try:
        if ipaddress.ip_address(host).is_loopback:
            return None
    except ValueError:
        pass
    return "接続先はこの PC（localhost / 127.0.0.1 / ::1）のみ指定できます"


def _load_settings() -> dict:
    try:
        data = json.loads(_settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    lemonade = dict(DEFAULT_LEMONADE)
    saved = data.get("lemonade") if isinstance(data, dict) else None
    if isinstance(saved, dict):
        for key in DEFAULT_LEMONADE:
            if isinstance(saved.get(key), str) and saved[key].strip():
                lemonade[key] = saved[key].strip()
    return {"lemonade": lemonade}


def _http_request(url: str, method: str = "GET", body: bytes | None = None,
                  headers: dict | None = None, timeout: float = 180) -> tuple[int, bytes]:
    """http.client で HTTP(S) を呼ぶ。
    urllib は必ず "Connection: close" を付けるため、Lemonade が音声の返送中に接続を切ってしまう。
    そのため http.client を使い、ステータスと本文をそのまま返す。"""
    parts = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.hostname, parts.port, timeout=timeout)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    try:
        conn.request(method, path, body=body, headers=headers or {})
        res = conn.getresponse()
        return res.status, res.read()
    finally:
        conn.close()


def _call_lemonade_speech(cfg: dict, text: str, voice: str) -> bytes:
    url = cfg["base_url"].rstrip("/") + "/api/v1/audio/speech"
    payload = json.dumps({"model": cfg["model"], "input": text, "voice": voice}, ensure_ascii=False).encode("utf-8")
    status, data = _http_request(url, "POST", payload,
                                 {"Content-Type": "application/json; charset=utf-8",
                                  "Content-Length": str(len(payload))})
    if status != 200:
        # 上流の応答本文は利用者へ返さない(詳細はログに残す)
        log.warning("Lemonade speech failed: HTTP %s %s", status, data.decode("utf-8", "replace")[:300])
        raise RuntimeError(f"Lemonade が音声を返しませんでした（HTTP {status}）")
    if not data:
        raise RuntimeError("Lemonade から空の音声が返りました")
    return data


def _http_get_status(url: str, timeout: float = 5) -> str:
    status, _ = _http_request(url, "GET", timeout=timeout)
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    return f"HTTP {status}"


@ROUTES.get("/pose_editor/audio/list")
async def audio_list(request):
    """GET /pose_editor/audio/list — Audio フォルダの音声一覧(新しい順)"""
    files = []
    for p in _audio_dir().iterdir():
        if p.is_file() and NAME_RE.match(p.name):
            st = p.stat()
            files.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
    files.sort(key=lambda f: f["mtime"], reverse=True)
    return web.json_response({"files": files, "dir": str(_audio_dir())})


@ROUTES.get("/pose_editor/audio/file/{name}")
async def audio_file(request):
    """GET /pose_editor/audio/file/<name> — 音声ファイルを返す(再生用)"""
    p = _audio_path(request.match_info["name"])
    if p is None:
        return web.json_response({"error": "not found"}, status=404)
    return web.FileResponse(p)


@ROUTES.post("/pose_editor/audio/delete")
async def audio_delete(request):
    """POST /pose_editor/audio/delete {name} — 音声ファイルを削除"""
    body = await request.json()
    p = _audio_path(str(body.get("name", "")))
    if p is None:
        return web.json_response({"error": "not found"}, status=404)
    p.unlink()
    return web.json_response({"ok": True})


@ROUTES.post("/pose_editor/tts/generate")
async def tts_generate(request):
    """POST /pose_editor/tts/generate {text, voice?} — Lemonade で音声を作成し Audio フォルダへ保存"""
    body = await request.json()
    text = str(body.get("text", "")).strip()
    if not text:
        return web.json_response({"error": "テキストが空です"}, status=400)
    if len(text) > MAX_TEXT_LEN:
        return web.json_response({"error": f"テキストは {MAX_TEXT_LEN} 文字以内にしてください"}, status=400)

    cfg = _load_settings()["lemonade"]
    err = _base_url_error(cfg["base_url"])
    if err:
        return web.json_response({"error": err}, status=400)
    voice = str(body.get("voice") or cfg["voice"]).strip() or cfg["voice"]
    voice_tag = re.sub(r"[^A-Za-z0-9_\-]", "", voice)[:32] or "voice"
    try:
        audio = await asyncio.to_thread(_call_lemonade_speech, cfg, text, voice)
    except Exception:  # noqa: BLE001 — 詳細はログへ。利用者には一般的な文言のみ返す
        log.exception("Lemonade speech generation failed")
        return web.json_response({"error": "音声の作成に失敗しました（サーバーのログを確認してください）"}, status=502)

    out_dir = _audio_dir()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    name = f"tts_{stamp}_{voice_tag}.mp3"
    n = 1
    while (out_dir / name).exists():
        name = f"tts_{stamp}_{voice_tag}_{n}.mp3"
        n += 1
    (out_dir / name).write_bytes(audio)
    return web.json_response({"name": name, "size": len(audio)})


@ROUTES.get("/pose_editor/tts/health")
async def tts_health(request):
    """GET /pose_editor/tts/health — Lemonade に接続できるか確認(S タブの接続テスト)"""
    cfg = _load_settings()["lemonade"]
    err = _base_url_error(cfg["base_url"])
    if err:
        return web.json_response({"ok": False, "error": err})
    url = cfg["base_url"].rstrip("/") + "/api/v1/health"
    try:
        status = await asyncio.to_thread(_http_get_status, url)
    except Exception:  # noqa: BLE001
        log.exception("Lemonade health check failed")
        return web.json_response({"ok": False, "error": "接続できませんでした（サーバーのログを確認してください）"})
    return web.json_response({"ok": True, "status": status})


@ROUTES.get("/pose_editor/tts/settings")
async def tts_settings_get(request):
    """GET /pose_editor/tts/settings — API 設定を返す"""
    return web.json_response({"settings": _load_settings()})


@ROUTES.post("/pose_editor/tts/settings")
async def tts_settings_post(request):
    """POST /pose_editor/tts/settings {lemonade: {base_url, model, voice}} — API 設定を保存"""
    body = await request.json()
    lemonade = body.get("lemonade") if isinstance(body, dict) else None
    if not isinstance(lemonade, dict):
        return web.json_response({"error": "lemonade の設定がありません"}, status=400)

    cleaned = {}
    for key in DEFAULT_LEMONADE:
        value = str(lemonade.get(key, "")).strip()
        if not value or len(value) > MAX_SETTING_LEN:
            return web.json_response({"error": f"{key} が空、または長すぎます"}, status=400)
        cleaned[key] = value
    err = _base_url_error(cleaned["base_url"])
    if err:
        return web.json_response({"error": err}, status=400)
    cleaned["base_url"] = cleaned["base_url"].rstrip("/")

    current = _load_settings()
    current["lemonade"] = cleaned
    _settings_path().write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return web.json_response({"settings": current})
