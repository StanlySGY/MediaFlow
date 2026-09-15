"""流式节流参数热改接口 —— 免重启调 partial 节奏，方便批量压测。

PUT /v1/config/stream   body: {"partial_interval_ms": 640, "min_partial_ms": 480}
GET  /v1/config/stream  返回当前生效值

改动直接落到 get_settings() 的单例上（engine/session/ws 都读同一个对象），
对新建立的会话即时生效；已存在的会话保持自己建立时的节流值不变。
逐会话覆盖见 ws start 帧的 partial_interval_ms / min_partial_ms 字段。

鉴权：ASR_ADMIN_TOKEN 非空则校验它；否则若 ASR_API_KEY 非空校验 api key；
两者都为空视为内网开发模式，放行（与服务的其余接口一致）。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Header, HTTPException, Request

from ..config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(tags=["runtime-config"])

_MUTABLE = {
    "partial_interval_ms": "stream_partial_interval_ms",
    "min_partial_ms": "stream_min_partial_ms",
    "max_sessions": "stream_max_sessions",
    "token_level": "stream_token_level",
}
_RANGE = {
    "partial_interval_ms": (50, 10_000),
    "min_partial_ms": (50, 10_000),
    "max_sessions": (1, 64),
}


def _check_auth(request: Request, authorization: Optional[str], x_admin_token: Optional[str]) -> None:
    s = get_settings()
    secret = s.admin_token or s.api_key
    if not secret:
        return  # 内网开发模式
    token = ""
    if x_admin_token:
        token = x_admin_token.strip()
    elif authorization and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
    else:
        token = request.query_params.get("api_key", "") or request.query_params.get("token", "")
    if token != secret:
        raise HTTPException(status_code=401, detail="invalid admin token")


def _current() -> Dict[str, Any]:
    s = get_settings()
    return {
        "partial_interval_ms": s.stream_partial_interval_ms,
        "min_partial_ms": s.stream_min_partial_ms,
        "partial_enabled": s.stream_partial_enabled,
        "max_sessions": s.stream_max_sessions,
        "token_level": s.stream_token_level,
    }


@router.get("/v1/config/stream", summary="读取流式节流参数（生效值）")
async def get_stream_config(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _check_auth(request, authorization, x_admin_token)
    return _current()


@router.put("/v1/config/stream", summary="热改流式节流参数（免重启）")
async def put_stream_config(
    payload: Dict[str, Any],
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _check_auth(request, authorization, x_admin_token)
    s = get_settings()
    applied: Dict[str, Any] = {}
    for key, value in (payload or {}).items():
        field = _MUTABLE.get(key)
        if field is None:
            raise HTTPException(
                status_code=400,
                detail=f"不支持的参数 {key}，可用: {sorted(_MUTABLE)}",
            )
        if key in _RANGE:
            lo, hi = _RANGE[key]
            try:
                iv = int(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{key} 必须是整数") from None
            if not lo <= iv <= hi:
                raise HTTPException(status_code=400, detail=f"{key} 需在 [{lo}, {hi}]")
            value = iv
        if key == "token_level":
            value = bool(value)
        setattr(s, field, value)
        applied[key] = value
    if not applied:
        raise HTTPException(status_code=400, detail="body 为空，没有要改的参数")
    logger.info("流式节流参数热改: %s（对新会话即时生效）", applied)
    return {"ok": True, "applied": applied, "current": _current()}
