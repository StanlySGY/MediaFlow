"""WebSocket 流式语音识别。

端点: ws://<host>:8022/v1/asr/stream

协议
----
客户端 → 服务端
  1) 首帧（可选，建议发）文本 JSON：
     {"type":"start","sample_rate":16000,"format":"pcm_s16le","channels":1,
      "language":"zh","enable_partial":true,"enable_vad":true}
  2) 之后持续发送二进制帧：裸 PCM（默认 16kHz / 单声道 / 16bit 小端）
     建议每帧 100~320ms，太小会增加调度开销，太大会拉高首字延迟。
  3) 结束：{"type":"stop"}    心跳：{"type":"ping"}    重置：{"type":"reset"}

服务端 → 客户端（均为 JSON 文本帧）
  {"type":"ready", ...}                            会话建立
  {"type":"speech_start","segment_id":0,...}       检测到人声起点
  {"type":"partial","segment_id":0,"text":"..."}   未定稿结果（会被后续覆盖）
  {"type":"delta","segment_id":0,"text":"好"}      定稿推理过程中的 token 级增量
  {"type":"final","segment_id":0,"text":"...",...} 该句定稿
  {"type":"speech_end","segment_id":0}             句子结束
  {"type":"done","text":"全文",...}                会话结束
  {"type":"error","message":"..."}                 异常
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional, Set

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from ..config import get_settings
from ..engine import get_engine
from ..session import SessionOptions, StreamSession

logger = logging.getLogger(__name__)
router = APIRouter(tags=["stream"])

_ACTIVE: Set[str] = set()


def active_session_count() -> int:
    return len(_ACTIVE)


def _check_auth(settings, api_key: Optional[str], ws: WebSocket) -> bool:
    if not settings.api_key:
        return True
    if api_key and api_key == settings.api_key:
        return True
    auth = ws.headers.get("authorization", "")
    if auth.startswith("Bearer ") and auth[7:].strip() == settings.api_key:
        return True
    if ws.headers.get("x-api-key", "") == settings.api_key:
        return True
    return False


async def _pump(ws: WebSocket, session: StreamSession, stop: asyncio.Event) -> None:
    """把会话产生的事件推给客户端，直到收到 done/aborted。"""
    while True:
        try:
            evt = await asyncio.wait_for(session.out.get(), timeout=1.0)
        except asyncio.TimeoutError:
            if stop.is_set() and session.out.empty():
                return
            continue
        if ws.client_state != WebSocketState.CONNECTED:
            return
        try:
            await ws.send_text(json.dumps(evt, ensure_ascii=False))
        except Exception:
            return
        if evt.get("type") in ("done", "aborted"):
            return


@router.websocket("/v1/asr/stream")
async def asr_stream(ws: WebSocket, api_key: Optional[str] = Query(default=None)) -> None:
    settings = get_settings()
    await ws.accept()

    if not _check_auth(settings, api_key, ws):
        await ws.send_text(json.dumps({"type": "error", "message": "unauthorized"}))
        await ws.close(code=4401)
        return

    if len(_ACTIVE) >= settings.stream_max_sessions:
        await ws.send_text(json.dumps({
            "type": "error",
            "message": f"并发会话已达上限 {settings.stream_max_sessions}，请稍后重试",
        }))
        await ws.close(code=4429)
        return

    engine = get_engine()
    if not engine.info.loaded:
        await ws.send_text(json.dumps({"type": "error", "message": "模型尚未加载完成"}))
        await ws.close(code=4503)
        return

    session: Optional[StreamSession] = None
    pump_task: Optional[asyncio.Task] = None
    stop_evt = asyncio.Event()
    sid = ""

    async def _start_session(payload: dict) -> None:
        nonlocal session, pump_task, sid
        options = SessionOptions.from_payload(payload, settings)
        session = StreamSession(engine=engine, settings=settings, options=options)
        sid = session.session_id
        _ACTIVE.add(sid)
        pump_task = asyncio.create_task(_pump(ws, session, stop_evt))
        await ws.send_text(json.dumps({
            "type": "ready",
            "session_id": sid,
            "backend": engine.info.backend,
            "device": engine.info.device,
            "target_sample_rate": settings.sample_rate,
            "accept_sample_rate": options.sample_rate,
            "format": options.audio_format,
            "language": options.language or "auto",
            "vad": options.enable_vad,
            "partial": options.enable_partial,
        }, ensure_ascii=False))

    try:
        while True:
            try:
                msg = await asyncio.wait_for(
                    ws.receive(), timeout=settings.stream_recv_timeout_s
                )
            except asyncio.TimeoutError:
                await ws.send_text(json.dumps({
                    "type": "error", "message": "接收超时，连接关闭"
                }))
                break

            if msg.get("type") == "websocket.disconnect":
                break

            # ---------------- 二进制音频 ----------------
            data = msg.get("bytes")
            if data:
                if session is None:
                    await _start_session({})
                await session.feed_bytes(data)
                continue

            # ---------------- 文本控制帧 ----------------
            text = msg.get("text")
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({
                    "type": "error", "message": "控制帧必须是合法 JSON"
                }, ensure_ascii=False))
                continue

            mtype = str(payload.get("type", "")).lower()

            if mtype in ("start", "config", "init"):
                if session is None:
                    await _start_session(payload)
                continue

            if mtype == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
                continue

            if mtype == "reset":
                if session is not None:
                    await session.abort("reset")
                    _ACTIVE.discard(sid)
                    stop_evt.set()
                    if pump_task:
                        await asyncio.wait([pump_task], timeout=3)
                stop_evt = asyncio.Event()
                session = None
                await _start_session(payload)
                continue

            if mtype in ("stop", "eof", "end"):
                break

            # 兼容 base64 内联音频
            if mtype == "audio" and payload.get("data"):
                import base64

                if session is None:
                    await _start_session({})
                await session.feed_bytes(base64.b64decode(payload["data"]))
                continue

    except WebSocketDisconnect:
        logger.info("客户端断开: %s", sid or "-")
    except Exception as exc:  # noqa: BLE001
        logger.exception("WebSocket 会话异常")
        if ws.client_state == WebSocketState.CONNECTED:
            try:
                await ws.send_text(json.dumps({
                    "type": "error", "message": f"{type(exc).__name__}: {exc}"
                }, ensure_ascii=False))
            except Exception:
                pass
    finally:
        try:
            if session is not None:
                await session.finish()
                stop_evt.set()
                if pump_task is not None:
                    try:
                        await asyncio.wait_for(pump_task, timeout=60)
                    except asyncio.TimeoutError:
                        pump_task.cancel()
        except Exception:
            logger.exception("会话收尾异常")
        finally:
            _ACTIVE.discard(sid)
            if ws.client_state == WebSocketState.CONNECTED:
                try:
                    await ws.close()
                except Exception:
                    pass
