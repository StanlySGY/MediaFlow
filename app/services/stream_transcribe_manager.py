from __future__ import annotations

import asyncio
import logging
import shutil
import time
import uuid
from collections import deque
from pathlib import Path
from typing import AsyncIterator

from app.config import Settings
from app.models.schemas import (
    RealtimeASREvent,
    RealtimeSessionCreate,
)
from app.services.asr import ASRError, RealtimeASRError, create_provider
from app.services.asr.call_limiter import ASRCallLimiter
from app.services.asr_monitoring import asr_call_context
from app.services.asr.realtime_base import classify_message
from app.services.audio_budget import (
    AllBatchesFailed,
    probe_audio_budget,
    transcribe_in_batches,
)
from app.services.ffmpeg_service import FFmpegError, normalize_to_wav

log = logging.getLogger(__name__)

# Matches RealtimeManager's replay window. Only events a reconnecting subscriber
# can still be sent are worth keeping; the transcript itself is archived.
_EVENT_HISTORY_SIZE = 512


def _failure_protocol(exc: BaseException) -> tuple[str, str | None, bool]:
    """`code` / `hint` / `retryable` for a stream transcription failure.

    Same shape as `stream_manager._failure_protocol`: decode failures are the
    caller's problem and not worth retrying, provider failures are.
    """
    if isinstance(exc, AllBatchesFailed):
        return "provider_rejected", "上游对全部片段识别失败，可稍后重试", True
    if isinstance(exc, RealtimeASRError):
        return exc.code, exc.hint, exc.retryable
    if isinstance(exc, FFmpegError):
        return "audio_invalid", "文件无法解码，请确认音视频格式", False
    code, hint, retryable = classify_message(str(exc))
    if isinstance(exc, ASRError) and code == "internal_error":
        return "provider_rejected", hint or "上游识别失败", True
    return code, hint, retryable


class StreamTranscribeManager:
    """管理文件上传流式转录会话"""

    def __init__(
        self,
        settings: Settings,
        *,
        asr_limiter: ASRCallLimiter | None = None,
    ) -> None:
        self._settings = settings
        # Same injected cap as TaskManager: splitting fans one upload out into
        # many provider calls, and two managers with private limiters would each
        # allow asr_concurrency of them at once.
        self._asr_limiter = asr_limiter or ASRCallLimiter(settings)
        self._sessions: dict[str, _TranscribeSession] = {}
        self._lock = asyncio.Lock()
        self._workers: set[asyncio.Task] = set()
        self._spawn_queue: asyncio.Queue[str] | None = None
        self._supervisor: asyncio.Task | None = None
        self._cleanup_task: asyncio.Task | None = None
        self._stopping = False

    # ---- lifespan ----

    async def start(self) -> None:
        """Spawn the worker supervisor. Call from app lifespan.

        Transcription tasks must be created from a task that lives in the app
        lifespan scope, not inside a request handler: anyio cancels
        request-scoped child tasks when the response finishes, which killed the
        worker before it could publish a terminal event and left every SSE
        subscriber waiting forever.
        """
        if self._supervisor is not None:
            return
        self._stopping = False
        self._spawn_queue = asyncio.Queue()
        self._supervisor = asyncio.create_task(self._spawn_loop())
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        self._stopping = True
        if self._supervisor is not None:
            self._supervisor.cancel()
            try:
                await self._supervisor
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._supervisor = None
        self._spawn_queue = None
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
        workers = list(self._workers)
        for worker in workers:
            worker.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)

    async def _cleanup_loop(self) -> None:
        interval = max(1, min(60, self._settings.realtime_session_ttl_seconds))
        try:
            while True:
                await asyncio.sleep(interval)
                async with self._lock:
                    self._evict_expired_locked()
        except asyncio.CancelledError:
            return

    def _evict_expired_locked(self) -> None:
        cutoff = time.time() - self._settings.realtime_session_ttl_seconds
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if session.done.is_set()
            and session.completed_at is not None
            and session.completed_at < cutoff
        ]
        for session_id in expired:
            self._sessions.pop(session_id, None)
            log.info("evicting expired stream transcription session %s", session_id)

    async def _spawn_loop(self) -> None:
        assert self._spawn_queue is not None
        try:
            while True:
                session_id = await self._spawn_queue.get()
                task = asyncio.create_task(self._run_transcription(session_id))
                self._workers.add(task)
                task.add_done_callback(self._workers.discard)
        except asyncio.CancelledError:
            return

    async def create_session(
        self, file_path: Path, config: RealtimeSessionCreate
    ) -> str:
        if self._stopping:
            raise RuntimeError("transcription manager is stopping")
        session_id = uuid.uuid4().hex
        session = _TranscribeSession(session_id, file_path, config, self._settings)
        async with self._lock:
            if self._stopping:
                raise RuntimeError("transcription manager is stopping")
            self._evict_expired_locked()
            # Counting and registering have to happen in one critical section,
            # otherwise two concurrent uploads both see "one live session" and
            # both get accepted. A finished session stops counting the moment
            # its worker publishes the terminal event, so `done` is the flag
            # that frees the slot -- same shape as realtime_max_sessions.
            limit = max(1, self._settings.stream_max_sessions)
            live = sum(1 for s in self._sessions.values() if not s.done.is_set())
            if live >= limit:
                raise RealtimeASRError(
                    f"同时转录已达上限（{live}/{limit} 路占用中），正在等待空位",
                    code="session_limit",
                    hint="正在等待空位",
                    retryable=True,
                    details={"live": live, "limit": limit},
                )
            self._sessions[session_id] = session
        if self._spawn_queue is None:
            # Bare scripts/tests that never called start(); the task is then
            # request-scoped and may be cancelled, but complete() in the
            # worker's finally still releases subscribers.
            task = asyncio.create_task(self._run_transcription(session_id))
            self._workers.add(task)
            task.add_done_callback(self._workers.discard)
        else:
            self._spawn_queue.put_nowait(session_id)
        return session_id

    async def stream_events(self, session_id: str) -> AsyncIterator[RealtimeASREvent]:
        session = self._sessions.get(session_id)
        if session is None:
            return
        async for evt in session.subscribe():
            yield evt

    async def _run_transcription(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            return

        work_dir: Path | None = None
        started_at = time.perf_counter()
        try:
            session.publish(
                RealtimeASREvent(
                    type="online", session_id=session_id, text="转录会话已启动"
                )
            )

            # 音频预处理
            work_dir = self._settings.temp_dir / session_id
            work_dir.mkdir(parents=True, exist_ok=True)
            normalized = work_dir / "normalized.wav"
            await normalize_to_wav(
                session.file_path, normalized, timeout=self._settings.ffmpeg_timeout
            )

            # 与文件任务链路同源：一次探测决定批次大小，超上限的整段音频交给切分器，
            # 分片数因此有 `duration / split_chunk_seconds` 的上界，内存、单次请求体
            # 体积和上游并发一起被这个上界管住（2 GiB 上传归一化后约 19 小时的
            # 16 kHz PCM，整段送上游是一次没人能超时覆盖的请求）。
            budget = await probe_audio_budget(normalized, self._settings)
            prompt = session.config.prompt_hints or None
            s = self._settings

            async with create_provider(s) as provider:

                async def call(path: Path, batch_prompt: str | None):
                    return await provider.transcribe(path, prompt=batch_prompt)

                with asr_call_context(
                    source="stream_transcribe",
                    session_id=session.session_id,
                ):
                    text, _words, batch_count, failed = await transcribe_in_batches(
                        normalized,
                        budget,
                        s,
                        work_dir=work_dir,
                        source="stream_transcribe",
                        key=session.session_id,
                        prompt=prompt,
                        transcribe_func=call,
                        limiter=self._asr_limiter,
                    )

            if failed:
                log.warning(
                    "stream session %s merged %d/%d batches (%d failed)",
                    session.session_id, batch_count - failed, batch_count, failed,
                )

            session.publish(
                RealtimeASREvent(
                    type="final",
                    session_id=session_id,
                    text=text,
                    is_final=True,
                    elapsed_ms=(time.perf_counter() - started_at) * 1000.0,
                )
            )
            session.publish(RealtimeASREvent(type="done", session_id=session_id))

        except asyncio.CancelledError:
            _, hint, _ = classify_message("转录任务被取消")
            session.publish(
                RealtimeASREvent(
                    type="error",
                    session_id=session_id,
                    error="转录任务被取消",
                    error_code="cancelled",
                    hint=hint,
                    retryable=False,
                )
            )
            raise
        except Exception as e:
            log.exception("transcription failed for session %s", session_id)
            code, hint, retryable = _failure_protocol(e)
            session.publish(
                RealtimeASREvent(
                    type="error",
                    session_id=session_id,
                    error=str(e),
                    error_code=code,
                    hint=hint,
                    retryable=retryable,
                )
            )
        finally:
            # Always release subscribers: without a terminal sentinel every SSE
            # client blocks on an empty queue until the connection is dropped.
            session.complete()
            session.file_path.unlink(missing_ok=True)
            if work_dir is not None and work_dir.exists():
                shutil.rmtree(work_dir, ignore_errors=True)

class _TranscribeSession:
    __slots__ = (
        "session_id",
        "file_path",
        "config",
        "settings",
        "events",
        "subscribers",
        "done",
        "created_at",
        "completed_at",
    )

    def __init__(
        self,
        session_id: str,
        file_path: Path,
        config: RealtimeSessionCreate,
        settings: Settings,
    ) -> None:
        self.session_id = session_id
        self.file_path = file_path
        self.config = config
        self.settings = settings
        # Bounded like the realtime manager's replay window: a long stream
        # would otherwise keep every event for the life of the session purely
        # so a late subscriber can replay them.
        self.events: deque[RealtimeASREvent] = deque(maxlen=_EVENT_HISTORY_SIZE)
        self.subscribers: set[asyncio.Queue[RealtimeASREvent | None]] = set()
        self.done = asyncio.Event()
        self.created_at = time.time()
        self.completed_at: float | None = None

    def publish(self, evt: RealtimeASREvent) -> None:
        self.events.append(evt)
        for q in self.subscribers:
            q.put_nowait(evt)

    def complete(self) -> None:
        self.done.set()
        self.completed_at = time.time()
        for q in self.subscribers:
            q.put_nowait(None)

    async def subscribe(self) -> AsyncIterator[RealtimeASREvent]:
        q: asyncio.Queue[RealtimeASREvent | None] = asyncio.Queue()
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
