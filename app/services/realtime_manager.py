from __future__ import annotations

import asyncio
import base64
import logging
import time
import uuid
from typing import AsyncIterator

from app.config import Settings
from app.models.schemas import (
    RealtimeASREvent,
    RealtimeAudioChunk,
    RealtimeSessionCreate,
    RealtimeSessionInfo,
    RealtimeSessionStatus,
)
from app.services.asr import create_realtime_provider
from app.services.asr.realtime_base import RealtimeASRError, RealtimeASRProvider, classify_message

log = logging.getLogger(__name__)


def _error_event(session_id: str, exc: BaseException) -> RealtimeASREvent:
    if isinstance(exc, RealtimeASRError):
        code, hint, retryable, message = exc.code, exc.hint, exc.retryable, str(exc)
    else:
        code, hint, retryable = classify_message(str(exc))
        message = str(exc)
    return RealtimeASREvent(
        type="error",
        session_id=session_id,
        error=message,
        error_code=code,
        hint=hint,
        retryable=retryable,
    )

# Statuses whose sessions no longer hold an upstream connection. They linger in
# the map only for SSE replay until TTL eviction, so they don't count against
# realtime_max_sessions.
_TERMINAL_STATUSES = frozenset({
    RealtimeSessionStatus.done,
    RealtimeSessionStatus.failed,
    RealtimeSessionStatus.closed,
})


class _Session:
    """Per-session state: event history, fan-out subscribers, provider lifecycle."""

    __slots__ = (
        "info", "config", "provider", "events", "subscribers", "done",
        "_finished", "_reader", "_lock",
    )

    def __init__(
        self,
        session_id: str,
        config: RealtimeSessionCreate,
        provider: RealtimeASRProvider,
    ) -> None:
        now = time.time()
        self.info = RealtimeSessionInfo(
            session_id=session_id,
            status=RealtimeSessionStatus.starting,
            events_url=f"/asr/realtime/{session_id}/events",
            audio_url=f"/asr/realtime/{session_id}/audio",
            end_url=f"/asr/realtime/{session_id}/end",
            created_at=now,
            updated_at=now,
        )
        self.config = config
        self.provider = provider
        self.events: list[RealtimeASREvent] = []
        self.subscribers: set[asyncio.Queue[RealtimeASREvent | None]] = set()
        self.done: asyncio.Event = asyncio.Event()
        self._finished = False
        self._reader: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    def touch(self) -> None:
        self.info.updated_at = time.time()

    def publish(self, evt: RealtimeASREvent) -> None:
        self.events.append(evt)
        for q in self.subscribers:
            q.put_nowait(evt)

    def complete(self, status: RealtimeSessionStatus, error: str | None = None) -> None:
        if self.done.is_set():
            return
        self.info.status = status
        if error:
            self.info.error = error
        self.done.set()
        for q in self.subscribers:
            q.put_nowait(None)

    async def subscribe(self) -> AsyncIterator[RealtimeASREvent]:
        q: asyncio.Queue[RealtimeASREvent | None] = asyncio.Queue()
        # Atomic snapshot + register (no await between these statements).
        for e in self.events:
            q.put_nowait(e)
        if self.done.is_set():
            q.put_nowait(None)
        else:
            self.subscribers.add(q)
        try:
            while True:
                evt = await q.get()
                if evt is None:
                    return
                yield evt
        finally:
            self.subscribers.discard(q)


class RealtimeSessionExists(RuntimeError):
    pass


class RealtimeManager:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._sessions: dict[str, _Session] = {}
        self._workers: set[asyncio.Task] = set()
        self._lock = asyncio.Lock()
        self._spawn_queue: asyncio.Queue[str] | None = None
        self._pump_loop_task: asyncio.Task | None = None

    # ---- lifespan ----

    async def start(self) -> None:
        """Spawn the pump-supervisor task. Call from app lifespan."""
        if self._pump_loop_task is not None:
            return
        self._spawn_queue = asyncio.Queue()
        self._pump_loop_task = asyncio.create_task(self._pump_loop())

    async def stop(self) -> None:
        for w in list(self._workers):
            w.cancel()
        for sid in list(self._sessions):
            try:
                await self.close(sid)
            except Exception:  # noqa: BLE001
                pass
        if self._pump_loop_task is not None:
            self._pump_loop_task.cancel()
            try:
                await self._pump_loop_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._pump_loop_task = None

    async def _pump_loop(self) -> None:
        """Long-lived supervisor: spawns per-session pump tasks. Lives in app lifespan
        scope so child tasks survive across request scopes (TestClient cancels
        tasks created inside request handlers via anyio cancel scopes)."""
        assert self._spawn_queue is not None
        try:
            while True:
                session_id = await self._spawn_queue.get()
                task = asyncio.create_task(self._pump_events(session_id))
                self._workers.add(task)
                task.add_done_callback(self._workers.discard)
        except asyncio.CancelledError:
            return

    # ---- lifecycle ----

    async def create(self, config: RealtimeSessionCreate) -> RealtimeSessionInfo:
        s = self._settings
        self._evict_expired()
        # Count only non-terminal sessions against the cap: a finished session no
        # longer holds an upstream connection, and TTL-not-yet-expired `done`
        # entries must not starve new recordings (they linger for replay).
        live = sum(
            1 for ses in self._sessions.values()
            if ses.info.status not in _TERMINAL_STATUSES
        )
        if live >= s.realtime_max_sessions:
            # 这是普通用户唯一会稳定撞到的容量错误，文案直接进前端提示，
            # 所以用中文并给出可操作信息，而不是抛出内部 key 的英文串。
            raise RealtimeASRError(
                f"同时录音已达上限（{s.realtime_max_sessions} 路），"
                "请等待他人结束录音后重试",
                code="session_limit",
                hint="请等待他人结束录音后重试",
                retryable=True,
            )

        session_id = uuid.uuid4().hex
        provider = create_realtime_provider(s)
        if hasattr(provider, "bind_session"):
            provider.bind_session(session_id)

        session = _Session(session_id, config, provider)
        async with self._lock:
            self._sessions[session_id] = session

        try:
            await provider.__aenter__()
            await provider.start(config)
            session.info.status = RealtimeSessionStatus.active
            session.touch()
        except Exception as e:  # noqa: BLE001
            log.exception("failed to start realtime session %s", session_id)
            self._sessions.pop(session_id, None)
            try:
                await provider.__aexit__(type(e), e, None)
            except Exception:  # noqa: BLE001
                pass
            raise RealtimeASRError(f"failed to start session: {e}") from e

        if self._spawn_queue is None:
            # Tests / scripts that drive the manager without app lifespan can
            # still create sessions and pump events synchronously via stream().
            # In production main.py always calls start() before serving.
            await self._pump_events_direct_fallback(session_id)
        else:
            self._spawn_queue.put_nowait(session_id)
        return session.info

    async def _pump_events_direct_fallback(self, session_id: str) -> None:
        """Used only when start() hasn't been called (bare scripts/tests)."""
        task = asyncio.create_task(self._pump_events(session_id))
        self._workers.add(task)
        task.add_done_callback(self._workers.discard)

    async def push_audio(self, session_id: str, chunk: RealtimeAudioChunk) -> RealtimeSessionInfo:
        """Push one audio chunk. Returns the updated session info so callers can
        read the running byte/chunk counters without a second round-trip."""
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError("session not found")
        if session.done.is_set():
            raise RealtimeASRError("session already closed", code="session_expired")

        # validate base64 payload (empty allowed only on final marker)
        if not chunk.audio and not chunk.is_final:
            raise ValueError("empty audio chunk requires is_final=true")
        decoded_size = 0
        if chunk.audio:
            try:
                decoded = base64.b64decode(chunk.audio, validate=True)
            except Exception as e:
                raise ValueError(f"invalid base64 audio: {e}") from e
            decoded_size = len(decoded)
            if decoded_size > self._settings.realtime_max_chunk_bytes:
                raise ValueError(
                    f"chunk exceeds realtime_max_chunk_bytes "
                    f"({decoded_size} > {self._settings.realtime_max_chunk_bytes})"
                )

        session.info.chunks_received += 1
        session.info.bytes_received += decoded_size
        session.touch()

        try:
            await session.provider.push_audio(chunk)
        except RealtimeASRError as e:
            session.publish(_error_event(session_id, e))
            session.complete(RealtimeSessionStatus.failed, str(e))
            raise
        return session.info

    async def finish(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError("session not found")
        if session.done.is_set():
            return
        session.info.status = RealtimeSessionStatus.finishing
        session.touch()
        try:
            await session.provider.finish()
        except RealtimeASRError as e:
            session.publish(_error_event(session_id, e))
            session.complete(RealtimeSessionStatus.failed, str(e))

    async def stream(self, session_id: str) -> AsyncIterator[RealtimeASREvent]:
        session = self._sessions.get(session_id)
        if session is None:
            return
        async for evt in session.subscribe():
            yield evt

    async def close(self, session_id: str) -> bool:
        session = self._sessions.get(session_id)
        if session is None:
            return False
        if not session.done.is_set():
            try:
                await session.provider.finish()
            except Exception:  # noqa: BLE001
                pass
            session.complete(RealtimeSessionStatus.closed)
        try:
            await session.provider.__aexit__(None, None, None)
        except Exception:  # noqa: BLE001
            log.warning("provider exit failed for %s", session_id, exc_info=True)
        self._sessions.pop(session_id, None)
        return True

    def get(self, session_id: str) -> RealtimeSessionInfo | None:
        s = self._sessions.get(session_id)
        return s.info if s else None

    def list(self) -> list[RealtimeSessionInfo]:
        return [s.info for s in self._sessions.values()]

    # ---- internals ----

    def _evict_expired(self) -> None:
        now = time.time()
        ttl = self._settings.realtime_session_ttl_seconds
        expired = [
            sid for sid, s in self._sessions.items()
            if (now - s.info.updated_at) > ttl
        ]
        for sid in expired:
            log.info("evicting expired realtime session %s", sid)
            asyncio.create_task(self.close(sid))

    async def _pump_events(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            return
        try:
            async for evt in session.provider.events():
                if evt.type == "error" and not evt.error_code:
                    code, hint, retryable = classify_message(evt.error or "")
                    evt = evt.model_copy(update={
                        "error_code": code,
                        "hint": hint,
                        "retryable": retryable,
                    })
                session.publish(evt)
                if evt.type == "done":
                    session.complete(RealtimeSessionStatus.done)
                    return
                if evt.type == "error":
                    session.complete(RealtimeSessionStatus.failed, evt.error)
                    return
        except Exception as e:  # noqa: BLE001
            log.exception("event pump failed for %s", session_id)
            session.publish(_error_event(session_id, e))
            session.complete(RealtimeSessionStatus.failed, str(e))
        finally:
            if not session.done.is_set():
                session.complete(RealtimeSessionStatus.done)
            # Pump ended => the provider will never yield again; release the
            # upstream connection immediately instead of holding one of the
            # upstream's scarce slots until TTL eviction. Events stay for replay.
            try:
                await session.provider.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001
                log.warning("provider exit after pump failed for %s", session_id,
                            exc_info=True)
