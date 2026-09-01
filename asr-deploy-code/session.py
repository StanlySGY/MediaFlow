"""流式识别会话：把连续音频流切成句子，并产出 partial / delta / final 事件。

时间轴模型
----------
  音频流 ──► StreamVad ──► speech_start / speech_end
                │
                ├─ 段内每 partial_interval_ms：对「段起点→当前」做一次快速推理 → partial（可被覆盖）
                └─ 段结束：对完整段做一次推理，token 级 delta 边出边推 → final（定稿）

内存策略：只保留「当前活跃段起点」之后的音频，定稿后立即裁剪，长连接不会无限增长。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np

from .audio import pcm_bytes_to_float32, resample_linear
from .config import Settings
from .engine import ASREngine
from .vad import StreamVad, VadConfig, VadEvent

logger = logging.getLogger(__name__)


@dataclass
class SessionOptions:
    sample_rate: int = 16000
    audio_format: str = "pcm_s16le"
    channels: int = 1
    language: Optional[str] = None
    enable_partial: bool = True
    enable_vad: bool = True
    max_new_tokens: Optional[int] = None

    @classmethod
    def from_payload(cls, payload: Dict[str, Any], settings: Settings) -> "SessionOptions":
        lang = payload.get("language") or settings.language_or_none
        return cls(
            sample_rate=int(payload.get("sample_rate") or settings.sample_rate),
            audio_format=str(payload.get("format") or "pcm_s16le").lower(),
            channels=int(payload.get("channels") or 1),
            language=lang if lang else None,
            enable_partial=bool(payload.get("enable_partial", settings.stream_partial_enabled)),
            enable_vad=bool(payload.get("enable_vad", settings.vad_enabled)),
            max_new_tokens=payload.get("max_new_tokens"),
        )


@dataclass
class StreamSession:
    engine: ASREngine
    settings: Settings
    options: SessionOptions
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex[:16])

    out: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=512), init=False)

    _vad: StreamVad = field(init=False)
    _audio: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32), init=False)
    _audio_start: int = field(default=0, init=False)   # _audio[0] 的全局采样点下标
    _seg_start: int = field(default=0, init=False)     # 当前段起点（全局采样点）
    _seg_id: int = field(default=0, init=False)
    _active: bool = field(default=False, init=False)   # 是否处于语音段内
    _closed: bool = field(default=False, init=False)
    _last_partial_at: float = field(default=0.0, init=False)
    _partial_task: Optional[asyncio.Task] = field(default=None, init=False)
    _final_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False)
    _finals: List[str] = field(default_factory=list, init=False)
    _total_samples: int = field(default=0, init=False)
    _t_start: float = field(default_factory=time.time, init=False)

    def __post_init__(self) -> None:
        s = self.settings
        self._vad = StreamVad(
            VadConfig(
                sample_rate=s.sample_rate,
                frame_ms=s.vad_frame_ms,
                energy_threshold=s.vad_energy_threshold,
                adaptive=s.vad_adaptive,
                silence_ms=s.vad_silence_ms,
                min_speech_ms=s.vad_min_speech_ms,
                speech_pad_ms=s.vad_speech_pad_ms,
            )
        )

    # ------------------------------------------------------------------ utils
    @property
    def sr(self) -> int:
        return self.settings.sample_rate

    def _ms(self, samples: int) -> int:
        return int(samples * 1000 / self.sr)

    async def _emit(self, event: Dict[str, Any]) -> None:
        event.setdefault("session_id", self.session_id)
        try:
            self.out.put_nowait(event)
        except asyncio.QueueFull:
            logger.warning("会话 %s 输出队列已满，丢弃事件 %s", self.session_id, event.get("type"))

    def _slice(self, start: int, end: int) -> np.ndarray:
        a = max(0, start - self._audio_start)
        b = max(a, min(self._audio.shape[0], end - self._audio_start))
        return self._audio[a:b]

    def _trim_before(self, global_idx: int) -> None:
        cut = global_idx - self._audio_start
        if cut > 0:
            self._audio = self._audio[cut:]
            self._audio_start = global_idx

    # ------------------------------------------------------------------- feed
    async def feed_bytes(self, data: bytes) -> None:
        if self._closed or not data:
            return
        chunk = pcm_bytes_to_float32(data, self.options.audio_format)
        if self.options.channels > 1:
            usable = chunk.shape[0] - (chunk.shape[0] % self.options.channels)
            chunk = chunk[:usable].reshape(-1, self.options.channels).mean(axis=1)
        if self.options.sample_rate != self.sr:
            chunk = resample_linear(chunk, self.options.sample_rate, self.sr)
        await self.feed_audio(chunk)

    async def feed_audio(self, chunk: np.ndarray) -> None:
        if self._closed or chunk.size == 0:
            return
        self._audio = np.concatenate([self._audio, chunk])
        self._total_samples += chunk.shape[0]

        if not self.options.enable_vad:
            await self._feed_no_vad(chunk)
            return

        for ev in self._vad.push(chunk):
            if ev is VadEvent.SPEECH_START:
                self._active = True
                self._seg_start = self._vad.speech_start_sample
                self._trim_before(self._seg_start)
                self._last_partial_at = time.time()
                await self._emit({
                    "type": "speech_start",
                    "segment_id": self._seg_id,
                    "start_ms": self._ms(self._seg_start),
                })
            elif ev is VadEvent.SPEECH_END:
                self._active = False
                await self._close_segment(self._vad.speech_end_sample)

        if self._active:
            await self._maybe_partial()
            await self._maybe_force_split()
        else:
            # 静音期：只保留尾部一点点做前置 padding
            keep = self.sr  # 1s
            self._trim_before(max(0, self._vad.cursor - keep))

    async def _feed_no_vad(self, chunk: np.ndarray) -> None:
        """不启用 VAD 时：整流当作一个长段，靠 partial 持续输出，stop 时定稿。"""
        if not self._active:
            self._active = True
            self._seg_start = self._audio_start
            self._last_partial_at = time.time()
            await self._emit({"type": "speech_start", "segment_id": self._seg_id, "start_ms": 0})
        await self._maybe_partial()
        await self._maybe_force_split()

    # --------------------------------------------------------------- partials
    def _cursor(self) -> int:
        return self._audio_start + self._audio.shape[0]

    async def _maybe_partial(self) -> None:
        if not (self.options.enable_partial and self.settings.stream_partial_enabled):
            return
        now = time.time()
        if (now - self._last_partial_at) * 1000.0 < self.settings.stream_partial_interval_ms:
            return
        seg_len = self._cursor() - self._seg_start
        if self._ms(seg_len) < self.settings.stream_min_partial_ms:
            return
        # 上一次 partial 还没跑完就跳过本轮，避免任务堆积压垮 NPU
        if self._partial_task is not None and not self._partial_task.done():
            return

        self._last_partial_at = now
        audio = self._slice(self._seg_start, self._cursor()).copy()
        seg_id = self._seg_id
        self._partial_task = asyncio.create_task(self._run_partial(seg_id, audio))

    async def _run_partial(self, seg_id: int, audio: np.ndarray) -> None:
        try:
            res = await self.engine.transcribe(
                audio,
                language=self.options.language,
                max_new_tokens=self.options.max_new_tokens,
                partial=True,
            )
            # 段已经定稿了，这条 partial 过期，丢弃
            if seg_id != self._seg_id or self._closed:
                return
            if res.text:
                await self._emit({
                    "type": "partial",
                    "segment_id": seg_id,
                    "text": res.text,
                    "language": res.language,
                    "infer_ms": res.infer_ms,
                })
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("partial 推理失败 seg=%s: %s", seg_id, exc)

    async def _maybe_force_split(self) -> None:
        seg_ms = self._ms(self._cursor() - self._seg_start)
        if seg_ms >= self.settings.segment_max_ms:
            logger.info("会话 %s 段 %s 超长(%sms)，强制定稿", self.session_id, self._seg_id, seg_ms)
            await self._close_segment(self._cursor())
            # 强制切分后立刻开启新段，保持连续
            self._active = True
            self._seg_start = self._cursor()
            self._last_partial_at = time.time()
            await self._emit({
                "type": "speech_start",
                "segment_id": self._seg_id,
                "start_ms": self._ms(self._seg_start),
            })

    # ----------------------------------------------------------------- finals
    async def _close_segment(self, end_sample: int) -> None:
        seg_id = self._seg_id
        start = self._seg_start
        end = max(start, end_sample)
        audio = self._slice(start, end).copy()

        # 段推进：让过期的 partial 自动失效
        self._seg_id += 1
        self._trim_before(end)

        if self._partial_task is not None and not self._partial_task.done():
            self._partial_task.cancel()
        self._partial_task = None

        dur_ms = self._ms(audio.shape[0])
        if dur_ms < self.settings.vad_min_speech_ms:
            logger.debug("段 %s 过短(%sms)，跳过", seg_id, dur_ms)
            await self._emit({"type": "speech_end", "segment_id": seg_id, "skipped": True})
            return

        async with self._final_lock:
            await self._run_final(seg_id, audio, start, end)

    async def _run_final(self, seg_id: int, audio: np.ndarray, start: int, end: int) -> None:
        try:
            final_evt: Optional[Dict[str, Any]] = None
            async for ev in self.engine.transcribe_iter(
                audio,
                language=self.options.language,
                max_new_tokens=self.options.max_new_tokens,
            ):
                if ev["type"] == "delta":
                    if ev.get("text"):
                        await self._emit({
                            "type": "delta", "segment_id": seg_id, "text": ev["text"]
                        })
                else:
                    final_evt = ev

            text = (final_evt or {}).get("text", "") or ""
            if text:
                self._finals.append(text)
            await self._emit({
                "type": "final",
                "segment_id": seg_id,
                "text": text,
                "language": (final_evt or {}).get("language"),
                "start_ms": self._ms(start),
                "end_ms": self._ms(end),
                "duration_ms": self._ms(end - start),
                "infer_ms": (final_evt or {}).get("infer_ms"),
                "rtf": (final_evt or {}).get("rtf"),
            })
            await self._emit({"type": "speech_end", "segment_id": seg_id})
        except Exception as exc:  # noqa: BLE001
            logger.exception("final 推理失败 seg=%s", seg_id)
            await self._emit({
                "type": "error", "segment_id": seg_id,
                "message": f"{type(exc).__name__}: {exc}",
            })

    # ------------------------------------------------------------------ close
    async def finish(self) -> None:
        """客户端发 stop / 连接正常结束时调用。"""
        if self._closed:
            return
        if self.options.enable_vad:
            events = self._vad.flush()
            if events or self._active:
                await self._close_segment(
                    self._vad.speech_end_sample or self._cursor()
                )
        elif self._active:
            await self._close_segment(self._cursor())

        self._active = False
        self._closed = True
        await self._emit({
            "type": "done",
            "segments": self._seg_id,
            "text": "".join(self._finals) if self._is_cjk() else " ".join(self._finals),
            "audio_ms": self._ms(self._total_samples),
            "wall_ms": int((time.time() - self._t_start) * 1000),
        })

    def _is_cjk(self) -> bool:
        joined = "".join(self._finals)[:200]
        if not joined:
            return False
        cjk = sum(1 for ch in joined if "\u4e00" <= ch <= "\u9fff")
        return cjk * 2 > len(joined)

    async def abort(self, reason: str = "aborted") -> None:
        self._closed = True
        if self._partial_task is not None and not self._partial_task.done():
            self._partial_task.cancel()
        await self._emit({"type": "aborted", "reason": reason})
