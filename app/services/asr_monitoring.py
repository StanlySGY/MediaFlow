from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterator


_context: ContextVar[dict[str, Any]] = ContextVar("asr_call_context", default={})
_TEXT_PREVIEW_CHARS = 200


@contextmanager
def asr_call_context(**values: Any) -> Iterator[None]:
    current = dict(_context.get())
    current.update({k: v for k, v in values.items() if v is not None})
    token = _context.set(current)
    try:
        yield
    finally:
        _context.reset(token)


@dataclass
class ASRCallRecord:
    call_id: str
    provider: str
    model: str
    base_url: str
    status: str = "running"
    source: str = ""
    task_id: str | None = None
    session_id: str | None = None
    segment_id: int | None = None
    request_bytes: int = 0
    text_chars: int = 0
    text_preview: str = ""
    declared_format: str = ""
    detected_format: str = ""
    input_bytes: int = 0
    audio_duration_ms: float | None = None
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    elapsed_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "status": self.status,
            "source": self.source,
            "task_id": self.task_id,
            "session_id": self.session_id,
            "segment_id": self.segment_id,
            "request_bytes": self.request_bytes,
            "text_chars": self.text_chars,
            "text_preview": self.text_preview,
            "declared_format": self.declared_format,
            "detected_format": self.detected_format,
            "input_bytes": self.input_bytes,
            "audio_duration_ms": (
                round(self.audio_duration_ms, 1)
                if self.audio_duration_ms is not None
                else None
            ),
            "error": self.error,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "elapsed_ms": round(self.elapsed_ms, 1),
        }


class ASRMonitor:
    def __init__(self, max_calls: int = 200) -> None:
        self._max_calls = max_calls
        self._calls: deque[ASRCallRecord] = deque(maxlen=max_calls)
        self._by_id: dict[str, ASRCallRecord] = {}
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    def reset(self) -> None:
        self._calls.clear()
        self._by_id.clear()
        for queue in list(self._subscribers):
            queue.put_nowait({"type": "reset", "snapshot": self.snapshot()})

    def start_call(
        self,
        *,
        provider: str,
        model: str,
        base_url: str,
        request_bytes: int = 0,
    ) -> str:
        ctx = _context.get()
        call = ASRCallRecord(
            call_id=uuid.uuid4().hex,
            provider=provider,
            model=model,
            base_url=base_url,
            source=str(ctx.get("source") or ""),
            task_id=ctx.get("task_id"),
            session_id=ctx.get("session_id"),
            segment_id=ctx.get("segment_id"),
            request_bytes=request_bytes,
            declared_format=str(ctx.get("declared_format") or ""),
            detected_format=str(ctx.get("detected_format") or ""),
            input_bytes=int(ctx.get("input_bytes") or 0),
            audio_duration_ms=ctx.get("audio_duration_ms"),
        )
        if len(self._calls) == self._max_calls:
            evicted = self._calls[-1]
            self._by_id.pop(evicted.call_id, None)
        self._calls.appendleft(call)
        self._by_id[call.call_id] = call
        self._publish({"type": "call_started", "call": call.to_dict()})
        return call.call_id

    def finish_call(
        self,
        call_id: str,
        *,
        ok: bool,
        text_chars: int = 0,
        text_preview: str | None = None,
        error: str | None = None,
    ) -> None:
        call = self._by_id.get(call_id)
        if call is None:
            return
        call.ended_at = time.time()
        call.elapsed_ms = max(0.0, (call.ended_at - call.started_at) * 1000.0)
        call.status = "ok" if ok else "error"
        call.text_chars = text_chars
        if text_preview:
            call.text_preview = text_preview[:_TEXT_PREVIEW_CHARS]
        call.error = error
        self._publish({"type": "call_finished", "call": call.to_dict()})

    def snapshot(self) -> dict[str, Any]:
        calls = [call.to_dict() for call in self._calls]
        completed = [c for c in self._calls if c.status in {"ok", "error"}]
        succeeded = sum(1 for c in self._calls if c.status == "ok")
        failed = sum(1 for c in self._calls if c.status == "error")
        running = sum(1 for c in self._calls if c.status == "running")
        avg_elapsed = (
            sum(c.elapsed_ms for c in completed) / len(completed) if completed else 0.0
        )
        return {
            "summary": {
                "total": len(self._calls),
                "running": running,
                "succeeded": succeeded,
                "failed": failed,
                "avg_elapsed_ms": round(avg_elapsed, 1),
                "window_size": self._max_calls,
            },
            "calls": calls,
        }

    async def subscribe(self) -> AsyncIterator[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._subscribers.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._subscribers.discard(queue)

    def _publish(self, event: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            queue.put_nowait(event)


asr_monitor = ASRMonitor()
