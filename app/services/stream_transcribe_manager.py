from __future__ import annotations

import asyncio
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import AsyncIterator

from app.config import Settings
from app.models.schemas import (
    RealtimeASREvent,
    RealtimeAudioChunk,
    RealtimeSessionCreate,
)
from app.services.asr import ASRError, create_provider
from app.services.asr_monitoring import asr_call_context
from app.services.asr.realtime_base import RealtimeASRError
from app.services.ffmpeg_service import normalize_to_wav

log = logging.getLogger(__name__)


class StreamTranscribeManager:
    """管理文件上传流式转录会话"""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._sessions: dict[str, _TranscribeSession] = {}
        self._lock = asyncio.Lock()
        self._workers: set[asyncio.Task] = set()
        self._spawn_queue: asyncio.Queue[str] | None = None
        self._supervisor: asyncio.Task | None = None

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
        self._spawn_queue = asyncio.Queue()
        self._supervisor = asyncio.create_task(self._spawn_loop())

    async def stop(self) -> None:
        for w in list(self._workers):
            w.cancel()
        if self._supervisor is not None:
            self._supervisor.cancel()
            try:
                await self._supervisor
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._supervisor = None

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
        session_id = uuid.uuid4().hex
        session = _TranscribeSession(session_id, file_path, config, self._settings)
        async with self._lock:
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

            # 调用 ASR
            async with create_provider(self._settings) as provider:
                with asr_call_context(
                    source="stream_transcribe",
                    session_id=session_id,
                ):
                    result = await provider.transcribe(normalized)
                session.publish(
                    RealtimeASREvent(
                        type="final",
                        session_id=session_id,
                        text=result.text,
                        is_final=True,
                    )
                )

            session.publish(RealtimeASREvent(type="done", session_id=session_id))

        except asyncio.CancelledError:
            session.publish(
                RealtimeASREvent(
                    type="error", session_id=session_id, error="转录任务被取消"
                )
            )
            raise
        except Exception as e:
            log.exception("transcription failed for session %s", session_id)
            session.publish(
                RealtimeASREvent(type="error", session_id=session_id, error=str(e))
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
        self.events: list[RealtimeASREvent] = []
        self.subscribers: set[asyncio.Queue[RealtimeASREvent | None]] = set()
        self.done = asyncio.Event()

    def publish(self, evt: RealtimeASREvent) -> None:
        self.events.append(evt)
        for q in self.subscribers:
            q.put_nowait(evt)

    def complete(self) -> None:
        self.done.set()
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
