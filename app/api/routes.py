from __future__ import annotations

import logging
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from sse_starlette.sse import EventSourceResponse

from app.config import get_settings
from app.models.schemas import TaskInfo, TaskResult, TaskStatus
from app.security import require_token
from app.services.stream_manager import TaskManager
from app.services.subtitles import to_srt, to_vtt

log = logging.getLogger(__name__)
router = APIRouter(prefix="/asr", tags=["asr"], dependencies=[Depends(require_token)])
meta_router = APIRouter(tags=["meta"])


def get_manager(request: Request) -> TaskManager:
    return request.app.state.manager


ALLOWED_EXTS = {
    ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg", ".pcm",
    ".mp4", ".mov", ".mkv",
}


@router.post("/task")
async def create_task(
    file: UploadFile = File(...),
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

    task_id = await manager.submit(dst, file.filename)
    return {"task_id": task_id}


@router.get("/task/{task_id}", response_model=TaskInfo)
async def get_status(task_id: str, manager: TaskManager = Depends(get_manager)) -> TaskInfo:
    info = manager.get_info(task_id)
    if info is None:
        raise HTTPException(404, "task not found")
    return info


@router.get("/task/{task_id}/stream")
async def stream_task(task_id: str, manager: TaskManager = Depends(get_manager)) -> EventSourceResponse:
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
async def get_result(task_id: str, manager: TaskManager = Depends(get_manager)) -> TaskResult | Response:
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
