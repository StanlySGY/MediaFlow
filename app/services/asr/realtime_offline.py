"""Realtime facade for offline ASR providers.

This adapter exists for providers such as OpenAI-compatible chat/audio ASR that
only accept a complete audio file. It preserves MediaFlow's realtime HTTP
contract by accepting base64 chunks, materializing them into a WAV file at the
end of the session, then streaming the recognized text back as SSE events.
"""
from __future__ import annotations

import asyncio
import base64
import shutil
import time
import uuid
import wave
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from app.config import Settings
from app.models.schemas import (
    RealtimeASREvent,
    RealtimeAudioChunk,
    RealtimeSessionCreate,
)
from app.services.asr.base import ASRProvider
from app.services.asr.registry import create_provider
from app.services.asr.realtime_base import RealtimeASRError
from app.services.asr_monitoring import asr_call_context
from app.services.ffmpeg_service import normalize_to_wav


SIMULATED_STREAMING = "simulated_streaming"
_TEXT_CHARS_PER_EVENT = 24


class RealtimeOfflineProvider:
    """Adapts a complete-file ASR provider to the realtime provider protocol."""

    def __init__(
        self,
        settings: Settings,
        *,
        provider_factory: Callable[[Settings], ASRProvider] = create_provider,
    ) -> None:
        self._settings = settings
        self._provider_factory = provider_factory
        self._queue: asyncio.Queue[RealtimeASREvent | None] = asyncio.Queue()
        self._session_id = ""
        self._config = RealtimeSessionCreate()
        self._started_at = 0.0
        self._audio = bytearray()
        self._finished = False
        self._work_dir: Path | None = None

    async def __aenter__(self) -> "RealtimeOfflineProvider":
        return self

    async def __aexit__(self, *exc) -> None:
        if not self._finished:
            self._queue.put_nowait(None)
        self._cleanup()

    def bind_session(self, session_id: str) -> None:
        self._session_id = session_id

    async def start(self, config: RealtimeSessionCreate) -> None:
        self._config = config
        self._started_at = time.perf_counter()
        suffix = self._session_id or uuid.uuid4().hex
        self._work_dir = self._settings.temp_dir / f"realtime_offline_{suffix}"
        self._work_dir.mkdir(parents=True, exist_ok=True)

    async def push_audio(self, chunk: RealtimeAudioChunk) -> None:
        if self._finished:
            raise RealtimeASRError("session already finished")
        if chunk.audio:
            try:
                self._audio.extend(base64.b64decode(chunk.audio, validate=True))
            except Exception as e:
                raise RealtimeASRError(f"invalid base64 audio: {e}") from e
        if chunk.is_final:
            await self.finish()

    async def finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        try:
            audio_path = await self._materialize_audio()
            async with self._provider_factory(self._settings) as provider:
                with asr_call_context(
                    source="realtime_offline",
                    session_id=self._session_id,
                ):
                    result = await provider.transcribe(
                        audio_path,
                        prompt=self._config.prompt_hints or None,
                    )
            await self._emit_text(result.text)
        except Exception as e:  # noqa: BLE001
            self._queue.put_nowait(
                RealtimeASREvent(
                    type="error",
                    session_id=self._session_id,
                    mode=SIMULATED_STREAMING,
                    error=str(e),
                )
            )
            self._queue.put_nowait(None)
            return
        finally:
            self._cleanup()

        elapsed = self._elapsed_ms()
        self._queue.put_nowait(
            RealtimeASREvent(
                type="final",
                session_id=self._session_id,
                text=result.text,
                is_final=True,
                elapsed_ms=elapsed,
                mode=SIMULATED_STREAMING,
            )
        )
        self._queue.put_nowait(
            RealtimeASREvent(
                type="done",
                session_id=self._session_id,
                is_final=True,
                elapsed_ms=elapsed,
                mode=SIMULATED_STREAMING,
            )
        )
        self._queue.put_nowait(None)

    def events(self) -> AsyncIterator[RealtimeASREvent]:
        return self._events()

    async def _events(self) -> AsyncIterator[RealtimeASREvent]:
        while True:
            evt = await self._queue.get()
            if evt is None:
                return
            yield evt

    async def _materialize_audio(self) -> Path:
        if not self._audio:
            raise RealtimeASRError("no audio received")
        if self._work_dir is None:
            await self.start(self._config)
        assert self._work_dir is not None

        data = bytes(self._audio)
        fmt = (self._config.format or "").lower().strip()
        if fmt in {"pcm", "pcm_s16le", "s16le", "raw"} and not data.startswith(b"RIFF"):
            return self._write_pcm_wav(data)

        if fmt in {"wav", "wave", "audio/wav", "audio/x-wav"} or data.startswith(
            b"RIFF"
        ):
            path = self._work_dir / "input.wav"
            path.write_bytes(data)
            return path

        src = self._work_dir / f"input{self._extension_for_format(fmt)}"
        dst = self._work_dir / "input.wav"
        src.write_bytes(data)
        await normalize_to_wav(src, dst, timeout=self._settings.ffmpeg_timeout)
        return dst

    def _write_pcm_wav(self, data: bytes) -> Path:
        assert self._work_dir is not None
        path = self._work_dir / "input.wav"
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(max(1, int(self._config.channels or 1)))
            wf.setsampwidth(2)
            wf.setframerate(max(1, int(self._config.sample_rate or 16000)))
            wf.writeframes(data)
        return path

    @staticmethod
    def _extension_for_format(fmt: str) -> str:
        normalized = fmt.split(";")[0].replace("audio/", "").replace("video/", "")
        mapping = {
            "aac": ".aac",
            "flac": ".flac",
            "m4a": ".m4a",
            "mp3": ".mp3",
            "mp4": ".mp4",
            "mpeg": ".mp3",
            "ogg": ".ogg",
            "opus": ".ogg",
            "webm": ".webm",
            "x-m4a": ".m4a",
        }
        return mapping.get(normalized, ".bin")

    async def _emit_text(self, text: str) -> None:
        if not text:
            return
        for seq, end in enumerate(
            range(
                _TEXT_CHARS_PER_EVENT,
                len(text) + _TEXT_CHARS_PER_EVENT,
                _TEXT_CHARS_PER_EVENT,
            ),
            start=1,
        ):
            self._queue.put_nowait(
                RealtimeASREvent(
                    type="online",
                    session_id=self._session_id,
                    seq=seq,
                    text=text[:end],
                    is_final=False,
                    elapsed_ms=self._elapsed_ms(),
                    mode=SIMULATED_STREAMING,
                )
            )
            await asyncio.sleep(0)

    def _elapsed_ms(self) -> float:
        return (time.perf_counter() - self._started_at) * 1000.0

    def _cleanup(self) -> None:
        if self._work_dir is not None:
            shutil.rmtree(self._work_dir, ignore_errors=True)
            self._work_dir = None
