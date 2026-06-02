from __future__ import annotations

import io
import logging
import time
import uuid
import wave
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from sse_starlette.sse import EventSourceResponse
from starlette.background import BackgroundTask

from app.config import (
    SENSITIVE_FIELDS,
    WRITABLE_FIELDS,
    get_settings,
    reset_runtime_overrides,
    update_runtime_overrides,
)
from app.models.schemas import (
    RealtimeAudioChunk,
    RealtimeSessionCreate,
    RealtimeSessionInfo,
    TaskInfo,
    TaskResult,
    TaskStatus,
)
from app.security import require_token
from app.services.asr import (
    ASRError,
    create_provider,
    list_providers,
    list_realtime_providers,
)
from app.services.asr.realtime_base import RealtimeASRError
from app.services.ffmpeg_service import FFmpegError, concat_media
from app.services.realtime_manager import RealtimeManager
from app.services.stream_manager import TaskManager
from app.services.subtitles import to_srt, to_vtt

log = logging.getLogger(__name__)
router = APIRouter(prefix="/asr", tags=["asr"], dependencies=[Depends(require_token)])
meta_router = APIRouter(tags=["meta"])
media_router = APIRouter(
    prefix="/media", tags=["media"], dependencies=[Depends(require_token)]
)


def get_manager(request: Request) -> TaskManager:
    return request.app.state.manager


def get_realtime_manager(request: Request) -> RealtimeManager:
    return request.app.state.realtime_manager


ALLOWED_EXTS = {
    ".mp3",
    ".wav",
    ".m4a",
    ".flac",
    ".aac",
    ".ogg",
    ".pcm",
    ".mp4",
    ".mov",
    ".mkv",
}


@router.post("/task")
async def create_task(
    file: UploadFile = File(...),
    model: str | None = Form(default=None),
    language: str | None = Form(default=None),
    split_strategy: str | None = Form(default=None),
    chunk_seconds: float | None = Form(default=None),
    overlap_seconds: float | None = Form(default=None),
    hotwords: str | None = Form(default=None),
    prompt_hints: str | None = Form(default=None),
    timestamps: bool | None = Form(default=None),
    manager: TaskManager = Depends(get_manager),
) -> dict[str, str]:
    settings = get_settings()
    if not file.filename:
        raise HTTPException(400, "missing filename")
    suffix = Path(file.filename).suffix.lower()
    if suffix and suffix not in ALLOWED_EXTS:
        raise HTTPException(400, f"unsupported file type: {suffix}")

    upload_id = uuid.uuid4().hex
    dst = settings.temp_dir / f"upload_{upload_id}{suffix or '.bin'}"
    limit = settings.max_upload_bytes
    written = 0
    try:
        async with aiofiles.open(dst, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > limit:
                    raise HTTPException(413, f"upload exceeds {limit} bytes")
                await out.write(chunk)
    except HTTPException:
        dst.unlink(missing_ok=True)
        raise
    except Exception:
        dst.unlink(missing_ok=True)
        raise

    overrides: dict = {}
    if model is not None:
        overrides["asr_model"] = model
    if language is not None:
        overrides["asr_language"] = language or None
    if split_strategy is not None:
        if split_strategy not in {"fixed", "silence", "overlap"}:
            dst.unlink(missing_ok=True)
            raise HTTPException(400, "split_strategy must be fixed|silence|overlap")
        overrides["split_strategy"] = split_strategy
    if chunk_seconds is not None:
        overrides["split_chunk_seconds"] = chunk_seconds
    if overlap_seconds is not None:
        overrides["split_overlap_seconds"] = overlap_seconds
    if hotwords is not None:
        overrides["asr_hotwords"] = hotwords
    if prompt_hints is not None:
        overrides["asr_prompt_hints"] = prompt_hints
    if timestamps is not None:
        overrides["asr_timestamps"] = timestamps

    task_id = await manager.submit(dst, file.filename, overrides=overrides or None)
    return {"task_id": task_id}


def _unlink_all(paths: list[Path]) -> None:
    for p in paths:
        p.unlink(missing_ok=True)


@media_router.post("/concat")
async def concat_media_files(files: list[UploadFile] = File(...)) -> FileResponse:
    """Merge same-format audio/video files in upload order without re-encoding.

    Stream-copy concat (ffmpeg concat demuxer): the output format equals the
    input format. All inputs must share one container/codec; mixing is rejected.
    """
    settings = get_settings()
    if len(files) < 2:
        raise HTTPException(400, "concat needs at least two files")

    suffixes = set()
    for f in files:
        if not f.filename:
            raise HTTPException(400, "missing filename")
        suffix = Path(f.filename).suffix.lower()
        if suffix not in ALLOWED_EXTS:
            raise HTTPException(400, f"unsupported file type: {suffix}")
        suffixes.add(suffix)
    if len(suffixes) != 1:
        raise HTTPException(400, "all files must share the same format")
    suffix = suffixes.pop()

    job_id = uuid.uuid4().hex
    limit = settings.max_upload_bytes
    parts = [
        settings.temp_dir / f"concat_{job_id}_{i}{suffix}" for i in range(len(files))
    ]
    dst = settings.temp_dir / f"concat_{job_id}{suffix}"
    written = 0
    try:
        for f, part in zip(files, parts):
            async with aiofiles.open(part, "wb") as out:
                while chunk := await f.read(1024 * 1024):
                    written += len(chunk)
                    if written > limit:
                        raise HTTPException(413, f"upload exceeds {limit} bytes")
                    await out.write(chunk)
        await concat_media(parts, dst, timeout=settings.ffmpeg_timeout)
    except HTTPException:
        _unlink_all(parts + [dst])
        raise
    except FFmpegError as e:
        _unlink_all(parts + [dst])
        raise HTTPException(400, f"concat failed: {e}") from e
    except Exception:
        _unlink_all(parts + [dst])
        raise

    return FileResponse(
        dst,
        filename=f"concat{suffix}",
        background=BackgroundTask(_unlink_all, parts + [dst]),
    )


@router.get("/task/{task_id}", response_model=TaskInfo)
async def get_status(
    task_id: str, manager: TaskManager = Depends(get_manager)
) -> TaskInfo:
    info = manager.get_info(task_id)
    if info is None:
        raise HTTPException(404, "task not found")
    return info


@router.get("/task/{task_id}/stream")
async def stream_task(
    task_id: str, manager: TaskManager = Depends(get_manager)
) -> EventSourceResponse:
    if manager.get_info(task_id) is None:
        raise HTTPException(404, "task not found")

    async def event_gen():
        async for evt in manager.stream(task_id):
            yield {"event": "segment", "data": evt.model_dump_json()}
        info = manager.get_info(task_id)
        if info is not None:
            yield {"event": "done", "data": info.model_dump_json()}

    return EventSourceResponse(event_gen())


@router.get("/task/{task_id}/result", response_model=TaskResult)
async def get_result(
    task_id: str, manager: TaskManager = Depends(get_manager)
) -> TaskResult | Response:
    result = manager.get_result(task_id)
    if result is None:
        raise HTTPException(404, "task not found")
    if result.status not in {TaskStatus.done, TaskStatus.failed}:
        return JSONResponse(status_code=202, content=result.model_dump(mode="json"))
    return result


@router.get("/task/{task_id}/subtitle", response_class=PlainTextResponse)
async def get_subtitle(
    task_id: str,
    format: str = "srt",
    manager: TaskManager = Depends(get_manager),
) -> Response:
    fmt = format.lower()
    if fmt not in {"srt", "vtt"}:
        raise HTTPException(400, "format must be 'srt' or 'vtt'")
    result = manager.get_result(task_id)
    if result is None:
        raise HTTPException(404, "task not found")
    if result.status != TaskStatus.done:
        raise HTTPException(409, f"task not ready (status={result.status.value})")

    body = to_srt(result.segments) if fmt == "srt" else to_vtt(result.segments)
    media = "application/x-subrip" if fmt == "srt" else "text/vtt"
    return Response(
        content=body,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{task_id}.{fmt}"'},
    )


@meta_router.get("/auth/info")
async def auth_info() -> dict[str, bool]:
    return {"auth_required": bool(get_settings().access_tokens_list)}


@router.get("/config")
async def get_config() -> dict:
    """Effective server configuration. Secrets (API key, tokens) are not included."""
    s = get_settings()
    return {
        "provider": s.asr_provider,
        "available_providers": list_providers(),
        "base_url": s.asr_base_url,
        "model": s.asr_model,
        "language": s.asr_language,
        "timeout": s.asr_timeout,
        "timestamps": s.asr_timestamps,
        "hotwords": s.asr_hotwords,
        "prompt_hints": s.asr_prompt_hints,
        "split_strategy": s.split_strategy,
        "chunk_seconds": s.split_chunk_seconds,
        "overlap_seconds": s.split_overlap_seconds,
        "silence_noise_db": s.silence_noise_db,
        "silence_min_duration": s.silence_min_duration,
        "concurrency": s.asr_concurrency,
        "max_retries": s.asr_max_retries,
        "retry_backoff": s.asr_retry_backoff,
        "ffmpeg_timeout": s.ffmpeg_timeout,
        "ffmpeg_concurrency": s.ffmpeg_concurrency,
        "max_upload_bytes": s.max_upload_bytes,
        "api_key_set": bool(s.asr_api_key),
        "access_tokens_count": len(s.access_tokens_list),
        "writable_fields": sorted(WRITABLE_FIELDS),
        "sensitive_fields": sorted(SENSITIVE_FIELDS),
        "runtime_config_path": str(s.runtime_config_path),
    }


@router.post("/config")
async def post_config(body: dict) -> dict:
    """Update runtime overrides (validated, persisted, applied to live Settings)."""
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    if not body:
        raise HTTPException(400, "no fields to update")

    # Empty-string fields are kept (user wants to clear), but we strip None.
    updates = {k: v for k, v in body.items() if v is not None}

    if "asr_provider" in updates and updates["asr_provider"] not in list_providers():
        raise HTTPException(
            400,
            f"unknown provider: {updates['asr_provider']}; available: {list_providers()}",
        )
    if "split_strategy" in updates and updates["split_strategy"] not in {
        "fixed",
        "silence",
        "overlap",
    }:
        raise HTTPException(400, "split_strategy must be fixed|silence|overlap")

    try:
        update_runtime_overrides(updates)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # pydantic validation etc.
        raise HTTPException(400, f"invalid update: {e}")

    return await get_config()


@router.post("/config/reset")
async def post_config_reset() -> dict:
    """Drop runtime overrides; revert all writable fields to .env defaults."""
    reset_runtime_overrides()
    return await get_config()


def _silent_wav_bytes(duration: float = 1.0, sample_rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * int(sample_rate * duration))
    return buf.getvalue()


@router.post("/ping")
async def ping_upstream() -> dict:
    """Send a 1s silent WAV to the configured ASR backend and report status."""
    settings = get_settings()
    tmp = settings.temp_dir / f"ping_{uuid.uuid4().hex}.wav"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(_silent_wav_bytes())

    t0 = time.perf_counter()
    try:
        async with create_provider(settings) as provider:
            res = await provider.transcribe(tmp)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return {
            "ok": True,
            "elapsed_ms": round(elapsed_ms, 1),
            "provider": settings.asr_provider,
            "base_url": settings.asr_base_url,
            "model": settings.asr_model,
            "text_preview": res.text[:100],
            "got_words": bool(res.words),
        }
    except ASRError as e:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return {
            "ok": False,
            "elapsed_ms": round(elapsed_ms, 1),
            "provider": settings.asr_provider,
            "base_url": settings.asr_base_url,
            "model": settings.asr_model,
            "error": str(e),
        }
    finally:
        tmp.unlink(missing_ok=True)


@router.get("/tasks")
async def list_tasks(
    manager: TaskManager = Depends(get_manager),
    limit: int = 50,
) -> dict:
    """List completed tasks (from outputs/ + in-memory active ones)."""
    s = get_settings()
    seen: set[str] = set()
    items: list[dict] = []

    # In-memory tasks (active + recently completed)
    for tid, t in list(manager._tasks.items()):  # noqa: SLF001
        seen.add(tid)
        items.append(
            {
                "task_id": tid,
                "status": t.info.status.value,
                "progress": t.info.progress,
                "total_segments": t.info.total_segments,
                "finished_segments": t.info.finished_segments,
                "duration": t.result.duration,
                "text_preview": (t.result.text or "")[:120],
                "error": t.info.error,
                "in_memory": True,
            }
        )

    # Persisted task results
    out_dir = s.output_dir
    if out_dir.is_dir():
        import json as _json

        for path in sorted(
            out_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
        ):
            tid = path.stem
            if tid in seen:
                continue
            try:
                data = _json.loads(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
            items.append(
                {
                    "task_id": tid,
                    "status": data.get("status", "done"),
                    "progress": 1.0,
                    "total_segments": len(data.get("segments", [])),
                    "finished_segments": len(data.get("segments", [])),
                    "duration": data.get("duration", 0.0),
                    "text_preview": (data.get("text") or "")[:120],
                    "error": data.get("error"),
                    "in_memory": False,
                    "mtime": path.stat().st_mtime,
                }
            )

    return {"tasks": items[:limit], "total": len(items)}


@router.get("/task/{task_id}/segments/{segment_id}/raw")
async def get_segment_raw(
    task_id: str,
    segment_id: int,
    manager: TaskManager = Depends(get_manager),
) -> dict:
    """Return the raw upstream ASR payload for a single segment (debug aid)."""
    result = manager.get_result(task_id)
    if result is None:
        raise HTTPException(404, "task not found")
    for seg in result.segments:
        if seg.segment_id == segment_id:
            return {
                "segment_id": seg.segment_id,
                "elapsed_ms": seg.elapsed_ms,
                "words": [w.model_dump() for w in seg.words],
                "raw": seg.raw,
                "error": seg.error,
            }
    raise HTTPException(404, "segment not found")


# -------------------- Realtime --------------------


@router.post("/realtime/session", response_model=RealtimeSessionInfo)
async def create_realtime_session(
    config: RealtimeSessionCreate,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> RealtimeSessionInfo:
    try:
        return await rm.create(config)
    except RealtimeASRError as e:
        raise HTTPException(503, str(e))


@router.get("/realtime/sessions")
async def list_realtime_sessions(
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> dict:
    return {
        "sessions": [s.model_dump() for s in rm.list()],
        "providers": list_realtime_providers(),
        "active_provider": get_settings().realtime_asr_provider,
    }


@router.get("/realtime/{session_id}", response_model=RealtimeSessionInfo)
async def get_realtime_session(
    session_id: str,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> RealtimeSessionInfo:
    info = rm.get(session_id)
    if info is None:
        raise HTTPException(404, "session not found")
    return info


@router.post("/realtime/{session_id}/audio")
async def push_realtime_audio(
    session_id: str,
    chunk: RealtimeAudioChunk,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> dict:
    try:
        await rm.push_audio(session_id, chunk)
    except KeyError:
        raise HTTPException(404, "session not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RealtimeASRError as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "seq": chunk.seq}


@router.get("/realtime/{session_id}/events")
async def stream_realtime_session(
    session_id: str,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> EventSourceResponse:
    if rm.get(session_id) is None:
        raise HTTPException(404, "session not found")

    async def event_gen():
        async for evt in rm.stream(session_id):
            yield {"event": evt.type, "data": evt.model_dump_json()}
        info = rm.get(session_id)
        if info is not None and info.status.value not in {"done", "failed", "closed"}:
            # safety fallback if the stream ended without a terminal event
            from app.models.schemas import RealtimeASREvent

            terminal = RealtimeASREvent(
                type="done", session_id=session_id, is_final=True
            )
            yield {"event": "done", "data": terminal.model_dump_json()}

    return EventSourceResponse(event_gen())


@router.post("/realtime/{session_id}/end")
async def end_realtime_session(
    session_id: str,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> dict:
    try:
        await rm.finish(session_id)
    except KeyError:
        raise HTTPException(404, "session not found")
    return {"ok": True}


@router.delete("/realtime/{session_id}")
async def delete_realtime_session(
    session_id: str,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> dict:
    removed = await rm.close(session_id)
    if not removed:
        raise HTTPException(404, "session not found")
    return {"ok": True}
