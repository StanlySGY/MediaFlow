"""HTTP 转写接口（OpenAI /v1/audio/transcriptions 兼容 + SSE 流式）。"""

from __future__ import annotations

import json
import logging
from typing import Optional

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, Header, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

from ..audio import audio_duration_s, decode_upload
from ..config import get_settings
from ..engine import get_engine
from ..schemas import TranscriptionResponse

logger = logging.getLogger(__name__)
router = APIRouter(tags=["transcription"])


async def verify_api_key(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> None:
    settings = get_settings()
    if not settings.api_key:
        return
    token = ""
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
    elif x_api_key:
        token = x_api_key.strip()
    else:
        token = request.query_params.get("api_key", "")
    if token != settings.api_key:
        raise HTTPException(status_code=401, detail="invalid api key")


async def _load_audio(file: UploadFile) -> np.ndarray:
    settings = get_settings()
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="上传文件为空")
    try:
        audio = await decode_upload(raw, settings.sample_rate, settings.ffmpeg_bin)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"音频解码失败: {exc}") from exc

    dur = audio_duration_s(audio, settings.sample_rate)
    if dur <= 0:
        raise HTTPException(status_code=400, detail="音频时长为 0")
    if dur > settings.max_audio_seconds:
        raise HTTPException(
            status_code=413,
            detail=f"音频过长 {dur:.1f}s，上限 {settings.max_audio_seconds}s。"
                   f"请改用 WebSocket 流式接口 /v1/asr/stream",
        )
    return audio


@router.post(
    "/v1/audio/transcriptions",
    summary="整段音频转写（OpenAI 兼容）",
    dependencies=[Depends(verify_api_key)],
)
async def transcriptions(
    file: UploadFile = File(..., description="音频文件，任意 ffmpeg 可解容器"),
    model: Optional[str] = Form(default=None),
    language: Optional[str] = Form(default=None),
    response_format: str = Form(default="json", description="json | text | verbose_json"),
    stream: bool = Form(default=False, description="true 则以 SSE 逐 token 返回"),
    max_new_tokens: Optional[int] = Form(default=None),
):
    settings = get_settings()
    engine = get_engine()
    if not engine.info.loaded:
        raise HTTPException(status_code=503, detail="模型尚未加载完成")

    audio = await _load_audio(file)
    lang = (language or settings.language_or_none) or None

    if stream:
        async def gen():
            try:
                async for ev in engine.transcribe_iter(audio, lang, max_new_tokens):
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            except Exception as exc:  # noqa: BLE001
                logger.exception("SSE 转写失败")
                err = {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
                yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    res = await engine.transcribe(audio, lang, max_new_tokens)

    if response_format == "text":
        return PlainTextResponse(res.text)

    payload = TranscriptionResponse(
        text=res.text,
        language=res.language,
        duration=res.duration_s,
        infer_ms=res.infer_ms,
        rtf=res.rtf,
    )
    if response_format == "verbose_json":
        return JSONResponse({
            **payload.model_dump(),
            "task": "transcribe",
            "backend": engine.info.backend,
            "device": engine.info.device,
            "raw": res.raw,
        })
    return JSONResponse(payload.model_dump(exclude_none=True))


@router.post(
    "/v1/asr/transcribe",
    response_model=TranscriptionResponse,
    summary="整段音频转写（简化别名）",
    dependencies=[Depends(verify_api_key)],
)
async def transcribe_alias(
    file: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
    max_new_tokens: Optional[int] = Form(default=None),
) -> TranscriptionResponse:
    settings = get_settings()
    engine = get_engine()
    if not engine.info.loaded:
        raise HTTPException(status_code=503, detail="模型尚未加载完成")
    audio = await _load_audio(file)
    res = await engine.transcribe(audio, (language or settings.language_or_none) or None,
                                  max_new_tokens)
    return TranscriptionResponse(
        text=res.text,
        language=res.language,
        duration=res.duration_s,
        infer_ms=res.infer_ms,
        rtf=res.rtf,
    )
