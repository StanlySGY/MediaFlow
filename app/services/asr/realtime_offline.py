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
        self._chunk_format = ""
        self._chunk_sample_rate: int | None = None
        self._chunk_channels: int | None = None
        self._monitor_audio_context: dict[str, object] = {}
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
        if chunk.format and not self._chunk_format:
            self._chunk_format = chunk.format
        if chunk.sample_rate:
            self._chunk_sample_rate = chunk.sample_rate
        if chunk.channels:
            self._chunk_channels = chunk.channels
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
                    **self._monitor_audio_context,
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
        fmt = self._declared_format()
        detected = self._detect_audio_format(data)

        if detected == "wav":
            path = self._work_dir / "input.wav"
            path.write_bytes(data)
            self._set_monitor_audio_context(data, fmt, detected, path)
            return path

        if detected:
            src = self._work_dir / f"input{self._extension_for_format(detected)}"
            dst = self._work_dir / "input.wav"
            src.write_bytes(data)
            await normalize_to_wav(src, dst, timeout=self._settings.ffmpeg_timeout)
            self._set_monitor_audio_context(data, fmt, detected, dst)
            return dst

        if fmt in {"pcm", "pcm_s16le", "s16le", "raw"}:
            return self._write_pcm_wav(data)

        if fmt in {"wav", "wave", "audio/wav", "audio/x-wav"}:
            path = self._work_dir / "input.wav"
            path.write_bytes(data)
            self._set_monitor_audio_context(data, fmt, "wav", path)
            return path

        src = self._work_dir / f"input{self._extension_for_format(fmt)}"
        dst = self._work_dir / "input.wav"
        src.write_bytes(data)
        await normalize_to_wav(src, dst, timeout=self._settings.ffmpeg_timeout)
        self._set_monitor_audio_context(data, fmt, fmt, dst)
        return dst

    def _write_pcm_wav(self, data: bytes) -> Path:
        assert self._work_dir is not None
        path = self._work_dir / "input.wav"
        channels = max(1, int(self._chunk_channels or self._config.channels or 1))
        sample_rate = max(
            1,
            int(self._chunk_sample_rate or self._config.sample_rate or 16000),
        )
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(data)
        self._set_monitor_audio_context(
            data,
            self._declared_format(),
            "pcm_s16le",
            path,
            duration_ms=(len(data) / max(1, sample_rate * channels * 2)) * 1000.0,
        )
        return path

    def _set_monitor_audio_context(
        self,
        data: bytes,
        declared_format: str,
        detected_format: str,
        wav_path: Path,
        *,
        duration_ms: float | None = None,
    ) -> None:
        self._monitor_audio_context = {
            "declared_format": declared_format,
            "detected_format": detected_format,
            "input_bytes": len(data),
            "audio_duration_ms": (
                duration_ms if duration_ms is not None else self._wav_duration_ms(wav_path)
            ),
        }

    def _declared_format(self) -> str:
        return (self._chunk_format or self._config.format or "").lower().strip()

    @staticmethod
    def _detect_audio_format(data: bytes) -> str | None:
        if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WAVE":
            return "wav"
        if data.startswith(b"\x1a\x45\xdf\xa3"):
            return "webm"
        if data.startswith(b"OggS"):
            return "ogg"
        if data.startswith(b"fLaC"):
            return "flac"
        if data.startswith(b"ID3") or (
            len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0
        ):
            return "mp3"
        if len(data) >= 12 and data[4:8] == b"ftyp":
            return "m4a"
        return None

    @staticmethod
    def _wav_duration_ms(path: Path) -> float | None:
        try:
            with wave.open(str(path), "rb") as wf:
                rate = wf.getframerate()
                if rate <= 0:
                    return None
                return (wf.getnframes() / rate) * 1000.0
        except Exception:  # noqa: BLE001
            return None

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
