"""轻量流式 VAD：能量(RMS) + 过零率 + 自适应噪声底。

为什么不用 webrtcvad / silero：
- webrtcvad 是 C 扩展，aarch64 离线环境需要现场编译，给交付增加不确定性；
- silero-vad 要再拉一个 torch 模型，占 NPU/内存且需要额外权重文件。
本实现零额外依赖（只用 numpy），在 16k 单声道会议/通话场景足够稳，
并且所有阈值都可通过环境变量调。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List

import numpy as np


class VadEvent(str, Enum):
    SPEECH_START = "speech_start"
    SPEECH_END = "speech_end"


@dataclass
class VadConfig:
    sample_rate: int = 16000
    frame_ms: int = 20
    energy_threshold: float = 0.012
    adaptive: bool = True
    silence_ms: int = 700
    min_speech_ms: int = 300
    speech_pad_ms: int = 200
    # 自适应参数
    noise_alpha: float = 0.95      # 噪声底平滑系数
    trigger_ratio: float = 3.0     # 语音判定 = max(绝对阈值, 噪声底 * ratio)
    zcr_max: float = 0.45          # 过零率过高通常是白噪/摩擦音，抑制误触发

    @property
    def frame_size(self) -> int:
        return max(1, int(self.sample_rate * self.frame_ms / 1000))

    @property
    def silence_frames(self) -> int:
        return max(1, int(self.silence_ms / self.frame_ms))

    @property
    def min_speech_frames(self) -> int:
        return max(1, int(self.min_speech_ms / self.frame_ms))

    @property
    def pad_frames(self) -> int:
        return max(0, int(self.speech_pad_ms / self.frame_ms))


@dataclass
class StreamVad:
    """增量式 VAD 状态机。

    用法：反复调用 `push(chunk)`，返回本次产生的事件列表。
    调用方根据事件驱动「出 partial / 出 final」的逻辑。
    """

    cfg: VadConfig = field(default_factory=VadConfig)

    _buffer: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32), init=False)
    _in_speech: bool = field(default=False, init=False)
    _speech_frames: int = field(default=0, init=False)
    _silence_frames: int = field(default=0, init=False)
    _pending_speech_frames: int = field(default=0, init=False)
    _noise_floor: float = field(default=0.0, init=False)
    _initialized: bool = field(default=False, init=False)
    # 相对整段会话的采样点游标
    _cursor: int = field(default=0, init=False)
    speech_start_sample: int = field(default=0, init=False)
    speech_end_sample: int = field(default=0, init=False)

    # ---------------------------------------------------------------- public
    def push(self, chunk: np.ndarray) -> List[VadEvent]:
        events: List[VadEvent] = []
        if chunk.size:
            self._buffer = np.concatenate([self._buffer, chunk.astype(np.float32, copy=False)])

        fs = self.cfg.frame_size
        while self._buffer.shape[0] >= fs:
            frame = self._buffer[:fs]
            self._buffer = self._buffer[fs:]
            events.extend(self._process_frame(frame))
            self._cursor += fs
        return events

    def flush(self) -> List[VadEvent]:
        """音频流结束时调用：若仍处于语音态则强制收尾。"""
        events: List[VadEvent] = []
        if self._buffer.size:
            self._cursor += self._buffer.shape[0]
            self._buffer = np.zeros(0, dtype=np.float32)
        if self._in_speech:
            self._in_speech = False
            self.speech_end_sample = self._cursor
            if self._speech_frames >= self.cfg.min_speech_frames:
                events.append(VadEvent.SPEECH_END)
        self._speech_frames = 0
        self._silence_frames = 0
        self._pending_speech_frames = 0
        return events

    def reset(self) -> None:
        self._buffer = np.zeros(0, dtype=np.float32)
        self._in_speech = False
        self._speech_frames = 0
        self._silence_frames = 0
        self._pending_speech_frames = 0
        self._noise_floor = 0.0
        self._initialized = False
        self._cursor = 0
        self.speech_start_sample = 0
        self.speech_end_sample = 0

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    @property
    def cursor(self) -> int:
        return self._cursor

    @property
    def noise_floor(self) -> float:
        return self._noise_floor

    # --------------------------------------------------------------- private
    def _process_frame(self, frame: np.ndarray) -> List[VadEvent]:
        events: List[VadEvent] = []
        rms = float(np.sqrt(np.mean(np.square(frame)) + 1e-12))
        zcr = float(np.mean(np.abs(np.diff(np.signbit(frame).astype(np.int8)))))

        if not self._initialized:
            self._noise_floor = rms
            self._initialized = True

        threshold = self.cfg.energy_threshold
        if self.cfg.adaptive:
            threshold = max(threshold, self._noise_floor * self.cfg.trigger_ratio)

        is_speech = rms > threshold and zcr < self.cfg.zcr_max

        # 只在非语音帧更新噪声底，避免把人声吃进噪声估计
        if not is_speech:
            a = self.cfg.noise_alpha
            self._noise_floor = a * self._noise_floor + (1.0 - a) * rms

        if not self._in_speech:
            if is_speech:
                self._pending_speech_frames += 1
                # 连续 2 帧命中才起判，抑制脉冲噪声
                if self._pending_speech_frames >= 2:
                    self._in_speech = True
                    self._speech_frames = self._pending_speech_frames
                    self._silence_frames = 0
                    pad = self.cfg.pad_frames * self.cfg.frame_size
                    start = self._cursor - self._pending_speech_frames * self.cfg.frame_size - pad
                    self.speech_start_sample = max(0, start)
                    self._pending_speech_frames = 0
                    events.append(VadEvent.SPEECH_START)
            else:
                self._pending_speech_frames = 0
        else:
            self._speech_frames += 1
            if is_speech:
                self._silence_frames = 0
            else:
                self._silence_frames += 1
                if self._silence_frames >= self.cfg.silence_frames:
                    self._in_speech = False
                    pad = self.cfg.pad_frames * self.cfg.frame_size
                    end = self._cursor - self._silence_frames * self.cfg.frame_size + pad
                    self.speech_end_sample = min(self._cursor, max(0, end))
                    emit = self._speech_frames - self._silence_frames >= self.cfg.min_speech_frames
                    self._speech_frames = 0
                    self._silence_frames = 0
                    if emit:
                        events.append(VadEvent.SPEECH_END)
        return events
