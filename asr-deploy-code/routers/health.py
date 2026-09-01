"""健康检查与服务信息。"""

from __future__ import annotations

import time

from fastapi import APIRouter, Response, status

from ..config import get_settings
from ..engine import get_engine
from ..schemas import HealthResponse, InfoResponse
from ..version import VERSION

router = APIRouter(tags=["system"])
_BOOT_TS = time.time()


@router.get("/healthz", response_model=HealthResponse, summary="存活探针")
async def healthz() -> HealthResponse:
    """进程存活即返回 200，用于 K8s liveness / docker healthcheck。"""
    try:
        eng = get_engine()
        loaded, backend, device = eng.info.loaded, eng.info.backend, eng.info.device
    except Exception:
        loaded, backend, device = False, "uninitialized", ""
    return HealthResponse(
        status="ok",
        model_loaded=loaded,
        backend=backend,
        device=device,
        uptime_s=round(time.time() - _BOOT_TS, 1),
    )


@router.get("/readyz", summary="就绪探针")
async def readyz(response: Response):
    """模型加载完成才返回 200，用于挂载流量前的判断。"""
    try:
        eng = get_engine()
        if eng.info.loaded:
            return {"status": "ready", "backend": eng.info.backend, "device": eng.info.device}
    except Exception:
        pass
    response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "loading"}


@router.get("/v1/info", response_model=InfoResponse, summary="服务与模型信息")
async def info() -> InfoResponse:
    s = get_settings()
    eng = get_engine()
    from .ws import active_session_count

    return InfoResponse(
        version=VERSION,
        model_path=eng.info.model_path,
        backend=eng.info.backend,
        device=eng.info.device,
        dtype=eng.info.dtype,
        npu_available=eng.info.npu_available,
        torch_version=eng.info.torch_version,
        torch_npu_version=eng.info.torch_npu_version,
        transformers_version=eng.info.transformers_version,
        load_seconds=eng.info.load_seconds,
        sample_rate=s.sample_rate,
        max_new_tokens=s.max_new_tokens,
        default_language=s.language_or_none,
        stream={
            "partial_enabled": s.stream_partial_enabled,
            "partial_interval_ms": s.stream_partial_interval_ms,
            "token_level": s.stream_token_level,
            "vad_enabled": s.vad_enabled,
            "vad_silence_ms": s.vad_silence_ms,
            "segment_max_ms": s.segment_max_ms,
            "max_sessions": s.stream_max_sessions,
            "ws_endpoint": "/v1/asr/stream",
        },
        active_sessions=active_session_count(),
    )
