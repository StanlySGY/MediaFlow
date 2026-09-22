"""Mock realtime ASR provider — produces deterministic events for testing the
realtime pipeline without needing a real ASR backend."""
from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator

from app.models.schemas import RealtimeASREvent, RealtimeAudioChunk, RealtimeSessionCreate
from app.services.asr.realtime_base import RealtimeASRError


class RealtimeMockProvider:
    """Emits one `online` event every N chunks and a `final` event on finish."""

    def __init__(
        self,
        *,
        online_every_n_chunks: int = 3,
        online_text: str = "...mock partial...",
        final_text: str = "Mock final transcription.",
    ) -> None:
        self._online_every = max(1, online_every_n_chunks)
        self._online_text = online_text
        self._final_text = final_text
        self._queue: asyncio.Queue[RealtimeASREvent | None] = asyncio.Queue()
        self._chunks_seen = 0
        self._session_id = ""
        self._started_at = 0.0
        self._finished = False
        self._event_seq = 0

    def _next_event_seq(self) -> int:
        seq = self._event_seq
        self._event_seq += 1
        return seq

    async def __aenter__(self) -> "RealtimeMockProvider":
        return self

    async def __aexit__(self, *exc) -> None:
        # Ensure the consumer iteration always terminates even if finish() wasn't called.
        if not self._finished:
            self._queue.put_nowait(None)

    def bind_session(self, session_id: str) -> None:
        self._session_id = session_id

    async def start(self, config: RealtimeSessionCreate) -> None:
        self._started_at = time.perf_counter()

    async def push_audio(self, chunk: RealtimeAudioChunk) -> None:
        if self._finished:
            raise RealtimeASRError("session already finished")
        self._chunks_seen += 1
        if self._chunks_seen % self._online_every == 0:
            self._queue.put_nowait(RealtimeASREvent(
                type="online",
                session_id=self._session_id,
                seq=self._next_event_seq(),
                text=f"{self._online_text} ({self._chunks_seen} chunks)",
                is_final=False,
                elapsed_ms=(time.perf_counter() - self._started_at) * 1000.0,
            ))
        if chunk.is_final:
            await self.finish()

    async def finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        elapsed = (time.perf_counter() - self._started_at) * 1000.0
        self._queue.put_nowait(RealtimeASREvent(
            type="final",
            session_id=self._session_id,
            seq=self._next_event_seq(),
            text=self._final_text,
            is_final=True,
            elapsed_ms=elapsed,
        ))
        self._queue.put_nowait(RealtimeASREvent(
            type="done",
            session_id=self._session_id,
            seq=self._next_event_seq(),
            is_final=True,
            elapsed_ms=elapsed,
        ))
        self._queue.put_nowait(None)

    async def events(self) -> AsyncIterator[RealtimeASREvent]:
        while True:
            evt = await self._queue.get()
            if evt is None:
                return
            yield evt
