"""Qwen3-ASR WebSocket provider with browser-audio transcoding.

MediaFlow clients upload a continuous browser recording, usually WebM/Opus.
The downstream Qwen3-ASR WebSocket accepts only raw PCM frames.  This provider
keeps one FFmpeg process per session, converts the incoming stream to 16 kHz
mono s16le, and sends 200 ms binary frames while recognition is in progress.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Any, AsyncIterator

import websockets
from websockets.exceptions import WebSocketException

from app.models.schemas import (
    RealtimeASREvent,
    RealtimeAudioChunk,
    RealtimeSessionCreate,
)
from app.services.asr.realtime_base import RealtimeASRError

log = logging.getLogger(__name__)

REALTIME_WS_MODE = "realtime_ws"
_TARGET_SAMPLE_RATE = 16000
_TARGET_CHANNELS = 1
_PCM_FRAME_MS = 200
_PCM_FRAME_BYTES = _TARGET_SAMPLE_RATE * 2 * _PCM_FRAME_MS // 1000

_PCM_INPUT_FORMATS: dict[str, str] = {
    "pcm": "s16le",
    "pcm_s16le": "s16le",
    "s16le": "s16le",
    "raw": "s16le",
    "pcm_f32le": "f32le",
    "f32le": "f32le",
    "pcm_s32le": "s32le",
    "s32le": "s32le",
}

_CLOSE_CODE_ERRORS: dict[int, str] = {
    4401: "authentication failed",
    4429: "concurrent session limit reached",
    4503: "model still loading",
}

# 上游 qwen-asr 只认语言全称（内部会对传入值做 capitalize 再查白名单，
# 所以 "zh" 会变成 "Zh" 被拒）。这里把常见 ISO 码翻成它认识的全称。
_LANGUAGE_ALIASES: dict[str, str] = {
    "zh": "Chinese",
    "zh-cn": "Chinese",
    "zh-hans": "Chinese",
    "cmn": "Chinese",
    "en": "English",
    "en-us": "English",
    "ja": "Japanese",
    "jp": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "ar": "Arabic",
}


def _normalize_language(language: str) -> str:
    """把语言码归一成上游认识的全称；已经是全称或未知值则原样首字母大写。"""
    key = language.strip()
    if not key:
        return ""
    mapped = _LANGUAGE_ALIASES.get(key.lower())
    if mapped:
        return mapped
    return key[:1].upper() + key[1:]


def _normalize_ws_url(url: str) -> str:
    url = url.strip()
    if url.startswith("http://"):
        return "ws://" + url[len("http://"):]
    if url.startswith("https://"):
        return "wss://" + url[len("https://"):]
    return url


def _normalize_audio_format(value: str | None) -> str:
    fmt = (value or "").lower().strip().split(";", 1)[0]
    if "/" in fmt:
        fmt = fmt.rsplit("/", 1)[-1]
    aliases = {
        "x-wav": "wav",
        "wave": "wav",
        "opus": "ogg",
        "mpeg": "mp3",
        "x-m4a": "m4a",
    }
    return aliases.get(fmt, fmt)


def _detect_audio_format(data: bytes) -> str | None:
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        return "wav"
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return "webm"
    if data.startswith(b"OggS"):
        return "ogg"
    if data.startswith(b"fLaC"):
        return "flac"
    if data.startswith(b"ID3"):
        return "mp3"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "m4a"
    return None


class RealtimeWSProvider:
    """Bridge MediaFlow realtime sessions to Qwen3-ASR ``/v1/asr/stream``."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str = "",
        model: str = "",
        timeout: float = 60.0,
        ffmpeg_bin: str = "ffmpeg",
    ) -> None:
        if not base_url:
            raise RealtimeASRError("realtime_ws requires realtime_asr_base_url to be set")
        self._base_url = _normalize_ws_url(base_url.rstrip("/"))
        self._api_key = api_key
        self._model = model
        self._timeout = timeout
        self._ffmpeg_bin = ffmpeg_bin

        self._ws: Any = None
        self._session_id = ""
        self._config = RealtimeSessionCreate()
        self._queue: asyncio.Queue[RealtimeASREvent | None] = asyncio.Queue()
        self._reader_task: asyncio.Task[None] | None = None
        self._ffmpeg: asyncio.subprocess.Process | None = None
        self._pcm_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[str] | None = None
        self._input_format = ""
        self._pcm_buffer = bytearray()
        self._audio_lock = asyncio.Lock()
        self._ws_send_lock = asyncio.Lock()

        self._finished = False
        self._terminal_received = False
        self._queue_closed = False
        self._started_at = 0.0
        self._event_seq = 0

        self._segment_order: list[str] = []
        self._partial_segments: dict[str, str] = {}
        self._delta_segments: dict[str, str] = {}
        self._final_segments: dict[str, str] = {}
        self._last_final_text = ""

    async def __aenter__(self) -> "RealtimeWSProvider":
        headers: list[tuple[str, str]] = []
        if self._api_key:
            headers.append(("Authorization", f"Bearer {self._api_key}"))
        try:
            self._ws = await websockets.connect(
                self._base_url,
                additional_headers=headers or None,
                open_timeout=self._timeout,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=10,
                max_size=None,
                proxy=None,
            )
        except (WebSocketException, OSError, TimeoutError) as e:
            raise RealtimeASRError(
                f"failed to open websocket to {self._base_url}: {e}"
            ) from e
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._abort_audio_pipeline()
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
            self._ws = None
        self._close_event_queue()

    def bind_session(self, session_id: str) -> None:
        self._session_id = session_id

    async def start(self, config: RealtimeSessionCreate) -> None:
        if self._ws is None:
            raise RuntimeError("provider must be used as async context manager")
        self._config = config
        self._started_at = time.perf_counter()
        try:
            await self._send_ws(json.dumps(self._build_start_frame(config)))
            raw = await asyncio.wait_for(self._ws.recv(), timeout=self._timeout)
        except TimeoutError as e:
            raise RealtimeASRError("timed out waiting for server ready frame") from e
        except WebSocketException as e:
            raise RealtimeASRError(
                f"connection closed awaiting ready frame: {e}"
            ) from e

        if isinstance(raw, bytes):
            raise RealtimeASRError(
                f"unexpected binary frame awaiting ready: {raw[:64]!r}"
            )
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, TypeError) as e:
            raise RealtimeASRError(f"invalid JSON in ready frame: {e}") from e
        if payload.get("type") == "error":
            raise RealtimeASRError(
                str(payload.get("message") or payload.get("error") or "downstream error")
            )
        if payload.get("type") != "ready":
            raise RealtimeASRError(f"expected ready frame, got: {payload}")

        self._reader_task = asyncio.create_task(self._read_events())

    async def push_audio(self, chunk: RealtimeAudioChunk) -> None:
        if self._ws is None or self._reader_task is None:
            raise RealtimeASRError("session not started")
        if self._finished:
            raise RealtimeASRError("session already finished")

        if chunk.audio:
            try:
                data = base64.b64decode(chunk.audio, validate=True)
            except Exception as e:
                raise RealtimeASRError(f"invalid base64 audio: {e}") from e
            if data:
                async with self._audio_lock:
                    await self._ensure_audio_pipeline(chunk, data)
                    if self._ffmpeg is None:
                        await self._feed_pcm(data)
                    else:
                        stdin = self._ffmpeg.stdin
                        if stdin is None or stdin.is_closing():
                            raise RealtimeASRError("FFmpeg audio input is closed")
                        try:
                            stdin.write(data)
                            await stdin.drain()
                        except (BrokenPipeError, ConnectionError, OSError) as e:
                            raise RealtimeASRError(
                                f"failed to feed browser audio to FFmpeg: {e}"
                            ) from e

        if chunk.is_final:
            await self.finish()

    async def finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        if self._ws is None or self._terminal_received:
            return

        try:
            async with self._audio_lock:
                await self._finish_audio_pipeline()
                await self._send_ws(json.dumps({"type": "stop"}))
        except RealtimeASRError:
            raise
        except Exception as e:  # noqa: BLE001
            raise RealtimeASRError(f"failed to finish websocket ASR session: {e}") from e

    async def events(self) -> AsyncIterator[RealtimeASREvent]:
        while True:
            evt = await self._queue.get()
            if evt is None:
                return
            yield evt

    def _build_start_frame(self, config: RealtimeSessionCreate) -> dict[str, Any]:
        frame: dict[str, Any] = {
            "type": "start",
            "sample_rate": _TARGET_SAMPLE_RATE,
            "format": "pcm_s16le",
            "channels": _TARGET_CHANNELS,
            "enable_partial": True,
            "enable_vad": True,
        }
        if config.language and config.language.strip().lower() != "auto":
            normalized = _normalize_language(config.language)
            if normalized:
                frame["language"] = normalized
        return frame

    async def _ensure_audio_pipeline(
        self,
        chunk: RealtimeAudioChunk,
        first_data: bytes,
    ) -> None:
        requested = _normalize_audio_format(chunk.format or self._config.format)
        detected = _detect_audio_format(first_data)
        actual = detected or requested or "pcm_s16le"

        if self._input_format:
            if detected and detected != self._input_format:
                raise RealtimeASRError(
                    f"audio format changed during session: {self._input_format} -> {detected}"
                )
            return

        self._input_format = actual
        sample_rate = int(chunk.sample_rate or self._config.sample_rate or 16000)
        channels = int(chunk.channels or self._config.channels or 1)
        direct_pcm = (
            _PCM_INPUT_FORMATS.get(actual) == "s16le"
            and sample_rate == _TARGET_SAMPLE_RATE
            and channels == _TARGET_CHANNELS
        )
        if direct_pcm:
            return
        await self._start_ffmpeg(actual, sample_rate, channels)

    async def _start_ffmpeg(self, fmt: str, sample_rate: int, channels: int) -> None:
        args = [self._ffmpeg_bin, "-hide_banner", "-loglevel", "error"]
        pcm_fmt = _PCM_INPUT_FORMATS.get(fmt)
        if pcm_fmt:
            args += [
                "-f", pcm_fmt,
                "-ar", str(max(1, sample_rate)),
                "-ac", str(max(1, channels)),
                "-i", "pipe:0",
            ]
        else:
            args += ["-i", "pipe:0"]
        args += [
            "-vn",
            "-f", "s16le",
            "-acodec", "pcm_s16le",
            "-ar", str(_TARGET_SAMPLE_RATE),
            "-ac", str(_TARGET_CHANNELS),
            "pipe:1",
        ]
        try:
            self._ffmpeg = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (OSError, asyncio.SubprocessError) as e:
            raise RealtimeASRError(f"failed to start FFmpeg: {e}") from e
        self._pcm_task = asyncio.create_task(self._pump_ffmpeg_pcm())
        self._stderr_task = asyncio.create_task(self._read_ffmpeg_stderr())

    async def _pump_ffmpeg_pcm(self) -> None:
        assert self._ffmpeg is not None and self._ffmpeg.stdout is not None
        while True:
            data = await self._ffmpeg.stdout.read(_PCM_FRAME_BYTES)
            if not data:
                break
            await self._feed_pcm(data)
        await self._flush_pcm()

    async def _read_ffmpeg_stderr(self) -> str:
        assert self._ffmpeg is not None and self._ffmpeg.stderr is not None
        data = await self._ffmpeg.stderr.read()
        return data.decode("utf-8", "replace")[-2000:]

    async def _feed_pcm(self, data: bytes) -> None:
        self._pcm_buffer.extend(data)
        while len(self._pcm_buffer) >= _PCM_FRAME_BYTES:
            frame = bytes(self._pcm_buffer[:_PCM_FRAME_BYTES])
            del self._pcm_buffer[:_PCM_FRAME_BYTES]
            await self._send_ws(frame)

    async def _flush_pcm(self) -> None:
        if self._pcm_buffer:
            frame = bytes(self._pcm_buffer)
            self._pcm_buffer.clear()
            await self._send_ws(frame)

    async def _finish_audio_pipeline(self) -> None:
        if self._ffmpeg is None:
            await self._flush_pcm()
            return

        process = self._ffmpeg
        if process.stdin is not None and not process.stdin.is_closing():
            process.stdin.close()
            try:
                await process.stdin.wait_closed()
            except (BrokenPipeError, ConnectionError):
                pass
        try:
            if self._pcm_task is not None:
                await asyncio.wait_for(self._pcm_task, timeout=self._timeout)
            return_code = await asyncio.wait_for(process.wait(), timeout=self._timeout)
            stderr = ""
            if self._stderr_task is not None:
                stderr = await asyncio.wait_for(self._stderr_task, timeout=2.0)
        except TimeoutError as e:
            await self._abort_audio_pipeline()
            raise RealtimeASRError("timed out draining FFmpeg audio pipeline") from e
        if return_code != 0:
            raise RealtimeASRError(
                f"FFmpeg audio conversion failed ({return_code}): {stderr.strip()[-400:]}"
            )
        self._ffmpeg = None
        self._pcm_task = None
        self._stderr_task = None

    async def _abort_audio_pipeline(self) -> None:
        process = self._ffmpeg
        if process is None:
            return
        if process.stdin is not None and not process.stdin.is_closing():
            process.stdin.close()
        for task in (self._pcm_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()
        if process.returncode is None:
            try:
                process.terminate()
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except (ProcessLookupError, TimeoutError):
                if process.returncode is None:
                    process.kill()
                    await process.wait()
        for task in (self._pcm_task, self._stderr_task):
            if task is not None:
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        self._ffmpeg = None
        self._pcm_task = None
        self._stderr_task = None

    async def _send_ws(self, data: str | bytes) -> None:
        if self._ws is None:
            raise RealtimeASRError("websocket is not connected")
        try:
            async with self._ws_send_lock:
                await self._ws.send(data)
        except WebSocketException as e:
            raise RealtimeASRError(f"failed to send websocket frame: {e}") from e

    async def _read_events(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    payload = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    log.debug("ignoring non-JSON websocket frame: %r", raw[:120])
                    continue
                if self._dispatch_server_frame(payload):
                    self._terminal_received = True
                    break
        except asyncio.CancelledError:
            raise
        except WebSocketException as e:
            self._emit_error(self._map_close_code(e), payload=None)
        except Exception as e:  # noqa: BLE001
            self._emit_error(str(e), payload=None)
        else:
            if not self._terminal_received:
                self._emit_error("websocket closed before done", payload=None)
        finally:
            self._close_event_queue()

    def _dispatch_server_frame(self, payload: dict[str, Any]) -> bool:
        kind = str(payload.get("type") or "")
        if kind in {"ready", "speech_end", "pong", "ping"}:
            return False
        if kind == "speech_start":
            self._remember_segment(self._segment_id(payload))
            return False
        if kind == "partial":
            segment_id = self._segment_id(payload)
            self._remember_segment(segment_id)
            text = str(payload.get("text") or payload.get("result") or "")
            self._partial_segments[segment_id] = text
            self._delta_segments.pop(segment_id, None)
            self._emit_text("online", self._render_text(segment_id, text), payload)
            return False
        if kind == "delta":
            segment_id = self._segment_id(payload)
            self._remember_segment(segment_id)
            token: Any = (
                payload.get("text")
                or payload.get("delta_text")
                or payload.get("delta")
                or payload.get("token")
                or ""
            )
            if isinstance(token, list):
                token = "".join(
                    str(item.get("text", "")) if isinstance(item, dict) else str(item)
                    for item in token
                )
            accumulated = self._delta_segments.get(segment_id, "") + str(token)
            self._delta_segments[segment_id] = accumulated
            self._emit_text(
                "online", self._render_text(segment_id, accumulated), payload
            )
            return False
        if kind == "final":
            segment_id = self._segment_id(payload)
            self._remember_segment(segment_id)
            text = str(payload.get("text") or payload.get("result") or "")
            self._final_segments[segment_id] = text
            self._partial_segments.pop(segment_id, None)
            self._delta_segments.pop(segment_id, None)
            full_text = self._render_text()
            self._last_final_text = full_text
            self._emit_text("final", full_text, payload, is_final=True)
            return False
        if kind == "done":
            full_text = str(payload.get("text") or self._render_text())
            if full_text and full_text != self._last_final_text:
                self._last_final_text = full_text
                self._emit_text("final", full_text, payload, is_final=True)
            self._queue.put_nowait(
                RealtimeASREvent(
                    type="done",
                    session_id=self._session_id,
                    seq=self._next_event_seq(),
                    text=full_text,
                    is_final=True,
                    elapsed_ms=self._payload_elapsed(payload),
                    mode=REALTIME_WS_MODE,
                    raw=payload,
                )
            )
            return True
        if kind == "error":
            self._emit_error(
                str(payload.get("message") or payload.get("error") or "downstream error"),
                payload=payload,
            )
            return True
        log.debug("unhandled realtime_ws frame: %s", payload)
        return False

    def _emit_text(
        self,
        event_type: str,
        text: str,
        payload: dict[str, Any],
        *,
        is_final: bool = False,
    ) -> None:
        self._queue.put_nowait(
            RealtimeASREvent(
                type=event_type,
                session_id=self._session_id,
                seq=self._next_event_seq(),
                text=text,
                is_final=is_final,
                elapsed_ms=self._payload_elapsed(payload),
                mode=REALTIME_WS_MODE,
                raw=payload,
            )
        )

    def _emit_error(self, message: str, *, payload: dict[str, Any] | None) -> None:
        if self._terminal_received:
            return
        self._terminal_received = True
        self._queue.put_nowait(
            RealtimeASREvent(
                type="error",
                session_id=self._session_id,
                seq=self._next_event_seq(),
                error=message,
                elapsed_ms=self._elapsed_ms(),
                mode=REALTIME_WS_MODE,
                raw=payload,
            )
        )

    @staticmethod
    def _segment_id(payload: dict[str, Any]) -> str:
        return str(payload.get("segment_id", payload.get("id", "0")))

    def _remember_segment(self, segment_id: str) -> None:
        if segment_id not in self._segment_order:
            self._segment_order.append(segment_id)

    def _render_text(self, active_segment: str | None = None, active_text: str = "") -> str:
        parts: list[str] = []
        for segment_id in self._segment_order:
            if segment_id in self._final_segments:
                parts.append(self._final_segments[segment_id])
            elif segment_id == active_segment and active_text:
                parts.append(active_text)
        return self._join_parts(parts)

    @staticmethod
    def _join_parts(parts: list[str]) -> str:
        result = ""
        for part in (value.strip() for value in parts if value.strip()):
            if (
                result
                and result[-1].isascii()
                and result[-1].isalnum()
                and part[0].isascii()
                and part[0].isalnum()
            ):
                result += " "
            result += part
        return result

    def _payload_elapsed(self, payload: dict[str, Any]) -> float:
        elapsed = payload.get("elapsed_ms")
        if isinstance(elapsed, (int, float)):
            return float(elapsed)
        return self._elapsed_ms()

    def _next_event_seq(self) -> int:
        self._event_seq += 1
        return self._event_seq

    def _map_close_code(self, exc: WebSocketException) -> str:
        close_code = getattr(exc, "code", None)
        if close_code in _CLOSE_CODE_ERRORS:
            return f"{_CLOSE_CODE_ERRORS[close_code]} (close {close_code})"
        received = getattr(exc, "rcvd", None)
        received_code = getattr(received, "code", None)
        if received_code in _CLOSE_CODE_ERRORS:
            return f"{_CLOSE_CODE_ERRORS[received_code]} (close {received_code})"
        return f"websocket closed: {exc}"

    def _close_event_queue(self) -> None:
        if not self._queue_closed:
            self._queue_closed = True
            self._queue.put_nowait(None)

    def _elapsed_ms(self) -> float:
        if not self._started_at:
            return 0.0
        return (time.perf_counter() - self._started_at) * 1000.0
