from __future__ import annotations

import asyncio
import base64
import logging
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

    async def create_session(
        self, file_path: Path, config: RealtimeSessionCreate
    ) -> str:
        session_id = uuid.uuid4().hex
        session = _TranscribeSession(session_id, file_path, config, self._settings)
        async with self._lock:
            self._sessions[session_id] = session
        asyncio.create_task(self._run_transcription(session_id))
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

            # 读取音频并转为 base64
            audio_data = normalized.read_bytes()
            audio_b64 = base64.b64encode(audio_data).decode()

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
            session.complete()

        except Exception as e:
            log.exception("transcription failed for session %s", session_id)
            session.publish(
                RealtimeASREvent(type="error", session_id=session_id, error=str(e))
            )
            session.complete()
        finally:
            session.file_path.unlink(missing_ok=True)
            if work_dir.exists():
                import shutil

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
