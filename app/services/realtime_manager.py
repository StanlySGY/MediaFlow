from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from collections import deque
from pathlib import Path
from typing import AsyncIterator, Iterable

from app.config import Settings
from app.models.schemas import (
    RealtimeASREvent,
    RealtimeAudioChunk,
    RealtimeSessionCreate,
    RealtimeSessionInfo,
    RealtimeSessionStatus,
)
from app.services.asr import create_realtime_provider
from app.services.asr.call_limiter import ASRCallLimiter
from app.services.asr.realtime_base import RealtimeASRError, RealtimeASRProvider, classify_message

log = logging.getLogger(__name__)


def _atomic_write_record(path: Path, record: dict) -> None:
    """Persist a realtime history record without exposing partially written JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


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

# Realtime recordings are filed into the same history list as file tasks, using
# the status values that list already understands: `closed` (TTL eviction, manual
# DELETE, process shutdown) is recorded as `cancelled` because the recording
# stopped on its own terms instead of failing upstream.
_KIND_REALTIME = "realtime"
_REALTIME_SUBSCRIBER_QUEUE_SIZE = 512
_REALTIME_EVENT_HISTORY_SIZE = 512
_REALTIME_CLOSE_DRAIN_TIMEOUT_SECONDS = 15.0
_REALTIME_PROVIDER_EXIT_TIMEOUT_SECONDS = 2.0
_RECORD_STATUS = {
    RealtimeSessionStatus.done: "done",
    RealtimeSessionStatus.failed: "failed",
    RealtimeSessionStatus.closed: "cancelled",
}


def _final_text(events: Iterable[RealtimeASREvent]) -> str:
    """The fullest transcript the provider ever published for this session.

    Every provider emits cumulative text on `final`/`done`, so the last final is
    the best view available. Two caveats that keep the record approximate:
    realtime_offline and realtime_mock emit `done` with an empty text, and
    realtime_ws compacts older finalized segments into a prefix so long-session
    transcripts keep their beginning while per-segment state remains bounded.
    """
    text = ""
    for evt in events:
        if evt.text and (evt.is_final or evt.type == "final"):
            text = evt.text
    if not text:
        for evt in reversed(events):
            if evt.text:
                return evt.text
    return text


def _last_error_event(events: list[RealtimeASREvent]) -> RealtimeASREvent | None:
    for evt in reversed(events):
        if evt.type == "error":
            return evt
    return None


def _archive_record(session: "_Session", status: RealtimeSessionStatus) -> dict | None:
    """Build the history record for one finished session, or None when there is
    nothing worth archiving (a session that never received audio)."""
    info = session.info
    # Transcript state is maintained separately from the bounded replay window;
    # archiving must not lose a final transcript just because old events were evicted.
    text = session.final_text or session.latest_text or _final_text(session.events)
    if not text and not info.chunks_received:
        return None

    error_text = info.error
    error = _last_error_event(session.events)
    error_code = error.error_code if error else None
    hint = error.hint if error else None
    retryable = error.retryable if error else None
    if error_text and error_code is None:
        error_code, hint, retryable = classify_message(error_text)

    started = time.localtime(info.created_at)
    model = (session.config.model or "").strip()
    label = f"实时录音 {time.strftime('%Y-%m-%d %H:%M', started)}"
    if model:
        label = f"{label} · {model}"

    return {
        "task_id": info.session_id,
        "kind": _KIND_REALTIME,
        "status": _RECORD_STATUS.get(status, "cancelled"),
        "session_status": status.value,
        "duration": max(0.0, (info.updated_at or time.time()) - info.created_at),
        "language": session.config.language,
        "text": text,
        # No segments: the upstream frames carry no utterance timestamps, so any
        # start/end here would be invented rather than measured.
        "segments": [],
        "error": error_text,
        "error_code": error_code,
        "hint": hint,
        "retryable": retryable,
        "original_name": label,
        "created_at": info.created_at,
        "updated_at": time.time(),
        "chunks_received": info.chunks_received,
        "bytes_received": info.bytes_received,
        "events_total": session.events_seen,
    }


class _Session:
    """Per-session state: event history, fan-out subscribers, provider lifecycle."""

    __slots__ = (
        "info", "config", "provider", "events", "subscribers", "done",
        "_finished", "_reader", "_lock", "final_text", "latest_text", "events_seen",
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
        # Replay is intentionally bounded. Keep the last terminal transcript
        # separately so the history window cannot truncate saved recordings.
        self.events: deque[RealtimeASREvent] = deque(maxlen=_REALTIME_EVENT_HISTORY_SIZE)
        self.final_text = ""
        self.latest_text = ""
        self.events_seen = 0
        self.subscribers: set[asyncio.Queue[RealtimeASREvent | None]] = set()
        self.done: asyncio.Event = asyncio.Event()
        self._finished = False
        self._reader: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    def touch(self) -> None:
        self.info.updated_at = time.time()

    @staticmethod
    def _enqueue(q: asyncio.Queue[RealtimeASREvent | None], evt: RealtimeASREvent | None) -> None:
        # A slow SSE client must not grow memory without bound. Keep the newest
        # events; completion is always enqueued, evicting one stale event if needed.
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait(evt)
        except asyncio.QueueFull:
            pass

    def publish(self, evt: RealtimeASREvent) -> None:
        self.events_seen += 1
        self.events.append(evt)
        if evt.text:
            self.latest_text = evt.text
            if evt.is_final or evt.type == "final":
                self.final_text = evt.text
        for q in self.subscribers:
            self._enqueue(q, evt)

    def complete(self, status: RealtimeSessionStatus, error: str | None = None) -> None:
        if self.done.is_set():
            return
        self.info.status = status
        if error:
            self.info.error = error
        self.done.set()
        for q in self.subscribers:
            self._enqueue(q, None)

    async def subscribe(self) -> AsyncIterator[RealtimeASREvent]:
        q: asyncio.Queue[RealtimeASREvent | None] = asyncio.Queue(
            maxsize=_REALTIME_SUBSCRIBER_QUEUE_SIZE
        )
        # Atomic snapshot + register (no await between these statements). Bound
        # replay to the newest events and reserve a slot for the terminal sentinel.
        replay_limit = _REALTIME_SUBSCRIBER_QUEUE_SIZE - int(self.done.is_set())
        for e in list(self.events)[-replay_limit:]:
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
    def __init__(
        self, settings: Settings, *, asr_limiter: ASRCallLimiter | None = None
    ) -> None:
        self._settings = settings
        # Only the offline adapter fans one session out into several provider
        # calls, but the cap is app-wide so its batches queue behind file tasks.
        self._asr_limiter = asr_limiter
        self._sessions: dict[str, _Session] = {}
        self._workers: set[asyncio.Task] = set()
        self._lock = asyncio.Lock()
        self._spawn_queue: asyncio.Queue[_Session] | None = None
        self._pump_loop_task: asyncio.Task | None = None
        self._cleanup_task: asyncio.Task | None = None

    # ---- lifespan ----

    async def start(self) -> None:
        """Spawn the pump-supervisor task. Call from app lifespan."""
        if self._pump_loop_task is not None:
            return
        self._spawn_queue = asyncio.Queue()
        self._pump_loop_task = asyncio.create_task(self._pump_loop())
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
        # Close sessions while their event pumps are still alive: finish() asks
        # upstream to flush its final transcript, and close() waits for the pump to
        # archive it. Cancelling workers first can lose tail frames and mislabel an
        # interrupted recording as `done` during process shutdown.
        for sid in list(self._sessions):
            try:
                await self.close(sid)
            except Exception:  # noqa: BLE001
                log.warning("failed to close realtime session during shutdown: %s", sid, exc_info=True)
        if self._pump_loop_task is not None:
            self._pump_loop_task.cancel()
            try:
                await self._pump_loop_task
            except asyncio.CancelledError:
                pass
            self._pump_loop_task = None
        workers = list(self._workers)
        for worker in workers:
            worker.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)

    async def _pump_loop(self) -> None:
        """Long-lived supervisor: spawns per-session pump tasks. Lives in app lifespan
        scope so child tasks survive across request scopes (TestClient cancels
        tasks created inside request handlers via anyio cancel scopes)."""
        assert self._spawn_queue is not None
        try:
            while True:
                session = await self._spawn_queue.get()
                task = asyncio.create_task(self._pump_events(session))
                session._reader = task
                self._workers.add(task)
                task.add_done_callback(self._workers.discard)
        except asyncio.CancelledError:
            return

    async def _cleanup_loop(self) -> None:
        interval = max(1, min(60, self._settings.realtime_session_ttl_seconds))
        try:
            while True:
                await asyncio.sleep(interval)
                async with self._lock:
                    expired = self._evict_expired_locked()
                await self._exit_expired(expired)
        except asyncio.CancelledError:
            return

    # ---- lifecycle ----

    async def create(self, config: RealtimeSessionCreate) -> RealtimeSessionInfo:
        s = self._settings
        session_id = uuid.uuid4().hex
        capacity_error: RealtimeASRError | None = None
        startup_error: BaseException | None = None
        provider: RealtimeASRProvider | None = None
        session: _Session | None = None
        async with self._lock:
            expired = self._evict_expired_locked()
            # Count only non-terminal sessions against the cap. The check and
            # registration must be one critical section or concurrent creates
            # can all observe the same free slot.
            live = sum(
                1 for ses in self._sessions.values()
                if ses.info.status not in _TERMINAL_STATUSES
            )
            limit = max(1, s.realtime_max_sessions)
            if live >= limit:
                capacity_error = RealtimeASRError(
                    f"同时录音已达上限（{live}/{limit} 路占用中），正在等待空位",
                    code="session_limit",
                    hint="正在等待空位",
                    retryable=True,
                    # "you are the fifth" and "the cap is one" need different
                    # answers, so both numbers ship with the refusal.
                    details={"live": live, "limit": limit},
                )
            else:
                try:
                    provider = create_realtime_provider(s)
                    if hasattr(provider, "bind_session"):
                        provider.bind_session(session_id)
                    if self._asr_limiter is not None and hasattr(provider, "bind_call_limiter"):
                        provider.bind_call_limiter(self._asr_limiter)
                    session = _Session(session_id, config, provider)
                    self._sessions[session_id] = session
                except Exception as exc:  # noqa: BLE001
                    startup_error = exc

        await self._exit_expired(expired)
        if capacity_error is not None:
            raise capacity_error
        if startup_error is not None:
            raise startup_error
        assert provider is not None and session is not None

        entered = False
        try:
            await provider.__aenter__()
            entered = True
            await provider.start(config)
            session.info.status = RealtimeSessionStatus.active
            session.touch()
        except asyncio.CancelledError as e:
            # Cancellation during provider startup must undo the early map
            # registration and release an already-entered upstream context.
            async with self._lock:
                self._sessions.pop(session_id, None)
            if entered:
                try:
                    await provider.__aexit__(type(e), e, e.__traceback__)
                except Exception:  # noqa: BLE001
                    log.warning("provider cleanup failed after startup cancellation", exc_info=True)
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("failed to start realtime session %s", session_id)
            async with self._lock:
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
            await self._pump_events_direct_fallback(session)
        else:
            self._spawn_queue.put_nowait(session)
        return session.info

    async def _pump_events_direct_fallback(self, session: _Session) -> None:
        """Used only when start() hasn't been called (bare scripts/tests)."""
        task = asyncio.create_task(self._pump_events(session))
        session._reader = task
        self._workers.add(task)
        task.add_done_callback(self._workers.discard)

    async def push_audio(self, session_id: str, chunk: RealtimeAudioChunk) -> RealtimeSessionInfo:
        """Push one audio chunk. Returns the updated session info so callers can
        read the running byte/chunk counters without a second round-trip."""
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError("session not found")

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

        terminal_error: RealtimeASRError | None = None
        cancelled = False
        async with session._lock:
            if session.done.is_set():
                raise RealtimeASRError("session already closed", code="session_expired")

            next_bytes = session.info.bytes_received + decoded_size
            if next_bytes > self._settings.realtime_max_session_bytes:
                terminal_error = RealtimeASRError(
                    f"累计音频已超过单次上限（{self._settings.realtime_max_session_bytes} bytes）",
                    code="resource_limit",
                    hint="请缩短录音后重试",
                    retryable=False,
                )
            elif time.time() - session.info.created_at >= self._settings.realtime_max_session_seconds:
                terminal_error = RealtimeASRError(
                    f"录音时长已达上限（{self._settings.realtime_max_session_seconds} 秒）",
                    code="resource_limit",
                    hint="请结束当前录音后重新开始",
                    retryable=False,
                )

            if terminal_error is not None:
                session.publish(_error_event(session_id, terminal_error))
                session.complete(RealtimeSessionStatus.failed, str(terminal_error))
            else:
                session.info.chunks_received += 1
                session.info.bytes_received += decoded_size
                session.touch()
                try:
                    await session.provider.push_audio(chunk)
                except asyncio.CancelledError:
                    session.complete(RealtimeSessionStatus.closed, "audio upload cancelled")
                    cancelled = True
                except Exception as exc:  # noqa: BLE001
                    error = (
                        exc
                        if isinstance(exc, RealtimeASRError)
                        else RealtimeASRError(str(exc))
                    )
                    session.publish(_error_event(session_id, error))
                    session.complete(RealtimeSessionStatus.failed, str(error))
                    terminal_error = error

        if cancelled:
            await self._exit_provider(session)
            raise asyncio.CancelledError
        if terminal_error is not None:
            await self._exit_provider(session)
            raise terminal_error
        return session.info

    async def finish(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError("session not found")
        provider_error: RealtimeASRError | None = None
        cancelled = False
        async with session._lock:
            if session.done.is_set():
                return
            session.info.status = RealtimeSessionStatus.finishing
            session.touch()
            try:
                await session.provider.finish()
            except asyncio.CancelledError:
                session.complete(RealtimeSessionStatus.closed, "session finish cancelled")
                cancelled = True
            except Exception as exc:  # noqa: BLE001
                provider_error = (
                    exc
                    if isinstance(exc, RealtimeASRError)
                    else RealtimeASRError(str(exc))
                )
                session.publish(_error_event(session_id, provider_error))
                session.complete(RealtimeSessionStatus.failed, str(provider_error))
        if cancelled:
            await self._exit_provider(session)
            raise asyncio.CancelledError
        if provider_error is not None:
            await self._exit_provider(session)
            raise provider_error

    async def stream(self, session_id: str) -> AsyncIterator[RealtimeASREvent]:
        session = self._sessions.get(session_id)
        if session is None:
            return
        async for evt in session.subscribe():
            yield evt

    async def close(self, session_id: str) -> bool:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return False

        reader = session._reader
        cancelled = False
        try:
            async with session._lock:
                if not session.done.is_set():
                    try:
                        # Ask upstream to flush its final result before closing its reader.
                        await session.provider.finish()
                    except asyncio.CancelledError:
                        # A cancelled DELETE must still release the upstream resource.
                        cancelled = True
                    except Exception:  # noqa: BLE001
                        log.warning(
                            "provider finish failed while closing %s", session_id, exc_info=True
                        )
                    # DELETE means the session is closed to new clients, but the existing
                    # pump still gets a bounded window to drain final upstream frames.
                    session.complete(RealtimeSessionStatus.closed)

            if not cancelled and reader is not None and reader is not asyncio.current_task() and not reader.done():
                drain_timeout = max(
                    1.0,
                    min(float(self._settings.asr_timeout), _REALTIME_CLOSE_DRAIN_TIMEOUT_SECONDS),
                )
                try:
                    await asyncio.wait_for(asyncio.shield(reader), timeout=drain_timeout)
                except TimeoutError:
                    log.warning("timed out draining realtime events for session %s", session_id)
                except asyncio.CancelledError:
                    cancelled = True
        except asyncio.CancelledError:
            cancelled = True
        finally:
            if not session.done.is_set():
                session.complete(RealtimeSessionStatus.closed)
            cleanup = asyncio.create_task(self._exit_provider(session))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
                try:
                    await cleanup
                except Exception:  # noqa: BLE001
                    log.warning("provider cleanup failed while closing %s", session_id, exc_info=True)
            except Exception:  # noqa: BLE001
                log.warning("provider cleanup failed while closing %s", session_id, exc_info=True)

            if reader is not None and reader is not asyncio.current_task() and not reader.done():
                try:
                    await asyncio.wait_for(
                        asyncio.shield(reader), timeout=_REALTIME_PROVIDER_EXIT_TIMEOUT_SECONDS
                    )
                except TimeoutError:
                    log.warning("realtime event pump did not stop after provider exit: %s", session_id)
                except asyncio.CancelledError:
                    if not reader.cancelled():
                        cancelled = True

        if cancelled:
            raise asyncio.CancelledError
        return True

    def get(self, session_id: str) -> RealtimeSessionInfo | None:
        s = self._sessions.get(session_id)
        return s.info if s else None

    def list(self) -> list[RealtimeSessionInfo]:
        return [s.info for s in self._sessions.values()]

    # ---- internals ----

    def _evict_expired_locked(self) -> list[_Session]:
        """Drop sessions idle past realtime_session_ttl_seconds.

        Archive happens in _exit_provider, which _exit_expired calls after this
        returns, so the record write stays out of the lock-held stretch.
        """
        now = time.time()
        ttl = self._settings.realtime_session_ttl_seconds
        expired = [
            s for s in self._sessions.values()
            if (now - s.info.updated_at) > ttl
        ]
        for session in expired:
            self._sessions.pop(session.info.session_id, None)
            session.complete(RealtimeSessionStatus.closed)
            log.info("evicting expired realtime session %s", session.info.session_id)
        return expired

    async def _exit_expired(self, sessions: list[_Session]) -> None:
        for session in sessions:
            await self._exit_provider(session)

    def _archive(self, session: _Session) -> None:
        """File one finished recording into the history archive.

        Called from the event pump (when the provider stream terminates) and from
        _exit_provider, which every teardown path funnels through (DELETE, TTL
        eviction, capacity/resource failure, shutdown) — so a recording lands in
        历史转写记录 as soon as the upstream connection is released, instead of up to
        realtime_session_ttl_seconds later, and a record exists even if the cleanup
        loop was never started.

        Both sites may run for the same session, in either order: DELETE archives
        while the pump is still draining the provider's last frames. The write is
        therefore a full rewrite from the events known so far rather than a
        once-only write — the event list only ever grows, so the last write is the
        fullest transcript, and an early write is a floor, not the final answer.
        """
        record = _archive_record(session, session.info.status)
        if record is None:
            return
        path = self._settings.output_dir / f"{record['task_id']}.json"
        try:
            _atomic_write_record(path, record)
        except Exception:  # noqa: BLE001
            log.warning("failed to archive realtime session %s", record["task_id"], exc_info=True)

    async def _exit_provider(self, session: _Session) -> None:
        async with session._lock:
            if session._finished:
                return
            session._finished = True
        self._archive(session)
        try:
            await session.provider.__aexit__(None, None, None)
        except Exception:  # noqa: BLE001
            log.warning("provider exit failed for %s", session.info.session_id,
                        exc_info=True)

    async def _pump_events(self, session: _Session) -> None:
        # The session object, not a lookup by id: DELETE and TTL eviction pop it
        # from the live map, and a pump that re-looks-up at that moment would drop
        # the frames finish() had just queued — exactly the tail a recording needs
        # before it is archived.
        session_id = session.info.session_id
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
            # Archive before releasing the provider: this is the point where every
            # frame the upstream ever sent is in session.events.
            self._archive(session)
            # Pump ended => the provider will never yield again; release the
            # upstream connection immediately instead of holding one of the
            # upstream's scarce slots until TTL eviction. Events stay for replay.
            await self._exit_provider(session)
