"""Bali StreetLens backend.

Serves the clip list (with status), observations JSON, camera config and the video files.
Inference never runs here: this only serves files that vision/analyze.py already wrote.

Run from the repo root:
    .venv\\Scripts\\python -m uvicorn backend.main:app --port 8000 --reload
"""

from __future__ import annotations

import asyncio
import gzip
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend import assistant, live
from backend.routing import RouteError, Router
from backend.tilecache import RemoteTiles, store

SCHEMA_VERSION = 1

ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = ROOT / "results"
FIXTURES_DIR = ROOT / "fixtures"
DATA_DIR = ROOT / "data"
TILES_DIR = DATA_DIR / "tiles"
CONFIG_DIR = ROOT / "config"
CORRIDOR_FILE = CONFIG_DIR / "corridor.json"
ROADS_FILE = CONFIG_DIR / "roads.json.gz"
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="Bali StreetLens")


@dataclass
class LoadedObservations:
    mtime_ns: int
    meta: dict[str, Any]  # every top-level field except "frames"
    raw: bytes
    gz: bytes


_cache: dict[Path, LoadedObservations] = {}


def _observation_files() -> dict[str, Path]:
    """Map clip id -> observations file. Real results win over fixtures with the same id."""
    files: dict[str, Path] = {}
    for path in sorted(FIXTURES_DIR.glob("*.json")):
        if not path.name.endswith(".truth.json"):
            files[path.stem] = path
    for path in sorted(RESULTS_DIR.glob("*.observations.json")):
        files[path.name.removesuffix(".observations.json")] = path
    return files


def _load(path: Path) -> LoadedObservations:
    mtime_ns = path.stat().st_mtime_ns
    cached = _cache.get(path)
    if cached and cached.mtime_ns == mtime_ns:
        return cached
    raw = path.read_bytes()
    doc = json.loads(raw)
    meta = {k: v for k, v in doc.items() if k != "frames"}
    loaded = LoadedObservations(mtime_ns, meta, raw, gzip.compress(raw, compresslevel=5))
    _cache[path] = loaded
    return loaded


def _video_path(meta: dict[str, Any], obs_path: Path) -> Path | None:
    name = Path(str(meta.get("video_file") or "")).name  # bare file name only
    if not name:
        return None
    for folder in (DATA_DIR, obs_path.parent):
        candidate = folder / name
        if candidate.is_file():
            return candidate
    return None


def _status(meta: dict[str, Any], obs_path: Path, video: Path | None) -> tuple[str, str]:
    version = meta.get("schema_version")
    if version != SCHEMA_VERSION:
        return "stale", f"schema_version {version}, aplikasi butuh {SCHEMA_VERSION}. Jalankan ulang analisis."
    if video is None:
        return "unavailable", f"Video '{meta.get('video_file')}' tidak ada di data/ atau di samping file observasi."
    if meta.get("source") == "synthetic":
        return "synthetic", "Data sintetis untuk pengembangan. Bukan lalu lintas nyata."
    if video.stat().st_mtime_ns > obs_path.stat().st_mtime_ns:
        return "stale", "File video lebih baru dari analisisnya. Jalankan ulang vision/analyze.py."
    return "analyzed", "Rekaman yang sudah dianalisis."


def _clip_info(clip_id: str, obs_path: Path) -> dict[str, Any]:
    try:
        meta = _load(obs_path).meta
    except (OSError, ValueError) as exc:
        return {"id": clip_id, "status": "unavailable", "reason": f"File observasi tidak bisa dibaca: {exc}"}
    video = _video_path(meta, obs_path)
    status, reason = _status(meta, obs_path, video)
    return {
        "id": clip_id,
        "camera_id": meta.get("camera_id"),
        "source": meta.get("source"),
        "video_file": meta.get("video_file"),
        "video_url": f"/video/{clip_id}" if video else None,
        "fps": meta.get("fps"),
        "frame_size": meta.get("frame_size"),
        "frame_count": meta.get("frame_count"),
        "model": meta.get("model"),
        "tracker": meta.get("tracker"),
        "status": status,
        "reason": reason,
    }


def _obs_path_or_404(clip_id: str) -> Path:
    path = _observation_files().get(clip_id)
    if path is None:
        raise HTTPException(404, f"Unknown clip '{clip_id}'")
    return path


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/clips")
def list_clips() -> list[dict[str, Any]]:
    return [_clip_info(clip_id, path) for clip_id, path in _observation_files().items()]


@app.get("/api/clips/{clip_id}/observations")
def get_observations(clip_id: str, request: Request) -> Response:
    try:
        loaded = _load(_obs_path_or_404(clip_id))
    except (OSError, ValueError) as exc:
        raise HTTPException(500, f"Could not read observations: {exc}") from exc
    headers = {"Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
    if "gzip" in request.headers.get("accept-encoding", ""):
        headers["Content-Encoding"] = "gzip"
        return Response(loaded.gz, media_type="application/json", headers=headers)
    return Response(loaded.raw, media_type="application/json", headers=headers)


@app.get("/api/clips/{clip_id}/config")
def get_config(clip_id: str) -> Any:
    try:
        camera_id = _load(_obs_path_or_404(clip_id)).meta.get("camera_id")
    except (OSError, ValueError) as exc:
        raise HTTPException(500, f"Could not read observations: {exc}") from exc
    path = CONFIG_DIR / f"{Path(str(camera_id)).name}.yaml"
    if not path.is_file():
        raise HTTPException(404, f"No config for camera '{camera_id}' (expected config/{camera_id}.yaml)")
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise HTTPException(500, f"config/{path.name} is not valid YAML: {exc}") from exc


@app.get("/video/{clip_id}")
def get_video(clip_id: str) -> FileResponse:
    obs_path = _obs_path_or_404(clip_id)
    video = _video_path(_load(obs_path).meta, obs_path)
    if video is None:
        raise HTTPException(404, f"Video for clip '{clip_id}' not found")
    # Starlette's FileResponse answers Range requests with 206, which the browser needs for seeking.
    return FileResponse(video, media_type="video/mp4")


_corridor_cache: tuple[int, dict[str, Any]] | None = None


def _corridor() -> dict[str, Any]:
    """config/corridor.json (built by `npm run corridor`), reloaded when the file changes."""
    global _corridor_cache
    if not CORRIDOR_FILE.is_file():
        raise HTTPException(503, "config/corridor.json is missing. Run `npm run corridor` in web/.")
    mtime = CORRIDOR_FILE.stat().st_mtime_ns
    if _corridor_cache is None or _corridor_cache[0] != mtime:
        _corridor_cache = (mtime, json.loads(CORRIDOR_FILE.read_text(encoding="utf-8")))
    return _corridor_cache[1]


@app.get("/api/corridor")
def get_corridor() -> dict[str, Any]:
    return _corridor()


@app.get("/api/cameras")
def get_cameras() -> Any:
    """Every camera on the provincial CCTV map (a dated snapshot), flagged when we analyse it."""
    path = CONFIG_DIR / "cameras.json"
    if not path.is_file():
        raise HTTPException(404, "config/cameras.json is missing")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/live/snapshot")
def live_snapshot() -> dict[str, Any]:
    return live.snapshot(_corridor())


@app.get("/api/live/stream")
async def live_stream(request: Request) -> StreamingResponse:
    """Server-sent events: one full corridor snapshot per second."""
    corridor = _corridor()

    async def events():
        while not await request.is_disconnected():
            yield f"data: {json.dumps(live.snapshot(corridor), separators=(',', ':'))}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


_router = Router(ROADS_FILE)
# Reading the island's road graph takes a few seconds: start right away so the first route is quick.
if _router.available:
    threading.Thread(target=_router.graph, name="load-roads", daemon=True).start()

# Generous box around the province: anything outside is a typo or a location outside Bali.
_BALI_BOX = (114.3, -9.05, 115.95, -7.9)


def _lnglat(value: str, what: str) -> tuple[float, float]:
    try:
        lng, lat = (float(v) for v in value.split(","))
    except ValueError:
        raise HTTPException(400, {"code": "bad_point", "message": f"'{what}' harus berbentuk lng,lat"}) from None
    if not (_BALI_BOX[0] <= lng <= _BALI_BOX[2] and _BALI_BOX[1] <= lat <= _BALI_BOX[3]):
        raise HTTPException(422, {"code": "outside_bali", "message": "Titik ini di luar Bali."})
    return lng, lat


@app.get("/api/route")
def get_route(from_: str = Query(alias="from"), to: str = Query()) -> dict[str, Any]:
    """Up to three routes from `from` to `to` (both "lng,lat"), with the watched junctions each passes.

    Live junction states steer the first route around a jam; distances only, no travel times.
    """
    corridor = _corridor()
    try:
        return _router.route(_lnglat(from_, "from"), _lnglat(to, "to"), corridor, live.snapshot(corridor))
    except RouteError as exc:
        status = 503 if exc.code == "no_graph" else 422
        raise HTTPException(status, {"code": exc.code, "message": str(exc)}) from exc


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    lang: Literal["id", "en"] = "id"


@app.get("/api/chat/status")
def chat_status() -> dict[str, Any]:
    """Whether the assistant can answer (a free Groq or NVIDIA key is set), without calling anyone."""
    return {"available": bool(assistant.configured_providers()), "providers": [p["name"] for p in assistant.configured_providers()]}


@app.post("/api/chat")
def post_chat(body: ChatRequest, request: Request) -> dict[str, Any]:
    """One answer from the free assistant (Groq, else NVIDIA), grounded in our own traffic data."""
    corridor = _corridor()
    client = request.client.host if request.client else "?"
    try:
        return assistant.chat([m.model_dump() for m in body.messages], body.lang, corridor, _router, client)
    except assistant.AssistantError as exc:
        raise HTTPException(exc.status, {"code": exc.code, "message": str(exc)}) from exc


_remote_tiles = RemoteTiles()
# Tiles beyond the build's max zoom are overzoomed by the map itself; never ask for them.
MAX_TILE_ZOOM = 15


@app.get("/tiles/{z}/{x}/{y}.mvt")
def get_tile(z: int, x: int, y: int) -> Response:
    """OpenStreetMap vector tiles for Bali: from data/tiles (npm run tiles), else fetched once and kept.

    Empty sea tiles, and any tile while offline, answer 204 so the map simply leaves that square blank.
    """
    path = TILES_DIR / str(z) / str(x) / f"{y}.mvt"
    headers = {"Cache-Control": "public, max-age=86400"}
    if path.is_file():
        return FileResponse(path, media_type="application/vnd.mapbox-vector-tile", headers=headers)
    if not 0 <= z <= MAX_TILE_ZOOM:
        return Response(status_code=204)
    data = _remote_tiles.tile(z, x, y)
    if data is None:  # offline: don't let the browser cache the blank
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    if not data:
        return Response(status_code=204, headers=headers)
    store(path, data)
    return Response(data, media_type="application/vnd.mapbox-vector-tile", headers=headers)


class SpaStaticFiles(StaticFiles):
    """Serves web/dist, answering unknown paths (/simpang/patung-kuda, /tim/...) with index.html."""

    async def get_response(self, path: str, scope: Any) -> Response:
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:  # StaticFiles raises Starlette's base class, not FastAPI's
            if exc.status_code != 404:
                raise
            return await super().get_response("index.html", scope)
        if response.status_code == 404:
            return await super().get_response("index.html", scope)
        return response


# The built app (npm run build) is served from the same origin, so the demo is one process.
if WEB_DIST.is_dir():
    app.mount("/", SpaStaticFiles(directory=WEB_DIST, html=True), name="web")
