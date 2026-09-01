"""音频工具：PCM 解码、重采样、任意容器格式转码（走 ffmpeg）。

设计原则：
- WebSocket 流式通道只接受裸 PCM（16-bit / 32-bit float 小端，单声道），
  避免在服务端做实时容器解封装，延迟最低、依赖最少。
- HTTP 整段上传接口允许任意格式，用 ffmpeg 统一转 16k/mono/f32。
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

SUPPORTED_PCM_FORMATS = ("pcm_s16le", "pcm_f32le", "pcm_s32le")


def pcm_bytes_to_float32(data: bytes, fmt: str = "pcm_s16le") -> np.ndarray:
    """把裸 PCM 字节流转成 [-1, 1] 区间的 float32 单声道数组。"""
    if not data:
        return np.zeros(0, dtype=np.float32)

    if fmt == "pcm_s16le":
        # 保证长度是 2 的倍数，半个采样点直接丢掉（流式分片常见）
        usable = len(data) - (len(data) % 2)
        arr = np.frombuffer(data[:usable], dtype="<i2").astype(np.float32) / 32768.0
    elif fmt == "pcm_s32le":
        usable = len(data) - (len(data) % 4)
        arr = np.frombuffer(data[:usable], dtype="<i4").astype(np.float32) / 2147483648.0
    elif fmt == "pcm_f32le":
        usable = len(data) - (len(data) % 4)
        arr = np.frombuffer(data[:usable], dtype="<f4").astype(np.float32)
    else:
        raise ValueError(f"unsupported pcm format: {fmt}, expect one of {SUPPORTED_PCM_FORMATS}")

    return np.clip(arr, -1.0, 1.0)


def downmix_to_mono(audio: np.ndarray, channels: int) -> np.ndarray:
    if channels <= 1:
        return audio
    usable = len(audio) - (len(audio) % channels)
    return audio[:usable].reshape(-1, channels).mean(axis=1)


def resample_linear(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """轻量线性插值重采样。

    只在客户端采样率与模型采样率不一致时兜底使用；生产环境建议客户端直接送 16k，
    质量更好也更省 CPU。
    """
    if src_sr == dst_sr or audio.size == 0:
        return audio.astype(np.float32, copy=False)
    duration = audio.shape[0] / float(src_sr)
    dst_len = int(round(duration * dst_sr))
    if dst_len <= 0:
        return np.zeros(0, dtype=np.float32)
    src_idx = np.linspace(0.0, audio.shape[0] - 1, num=dst_len, dtype=np.float64)
    return np.interp(src_idx, np.arange(audio.shape[0]), audio).astype(np.float32)


def ffmpeg_available(ffmpeg_bin: str = "ffmpeg") -> bool:
    return shutil.which(ffmpeg_bin) is not None


def decode_with_ffmpeg(
    raw: bytes,
    target_sr: int = 16000,
    ffmpeg_bin: str = "ffmpeg",
    timeout: int = 120,
) -> np.ndarray:
    """用 ffmpeg 把任意音频容器解码为 float32 mono@target_sr。"""
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", "pipe:0",
        "-f", "f32le",
        "-acodec", "pcm_f32le",
        "-ac", "1",
        "-ar", str(target_sr),
        "pipe:1",
    ]
    try:
        proc = subprocess.run(
            cmd, input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout
        )
    except FileNotFoundError as exc:  # pragma: no cover
        raise RuntimeError(
            f"ffmpeg 不可用（{ffmpeg_bin}）。请在镜像内安装 ffmpeg，或改用 WAV/PCM 输入。"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("ffmpeg 解码超时") from exc

    if proc.returncode != 0:
        msg = proc.stderr.decode("utf-8", errors="ignore")[:500]
        raise RuntimeError(f"ffmpeg 解码失败: {msg}")

    return np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32, copy=False)


def decode_wav_fallback(raw: bytes, target_sr: int = 16000) -> Optional[np.ndarray]:
    """无 ffmpeg 时的 WAV 兜底解码（依赖 soundfile）。"""
    try:
        import io

        import soundfile as sf
    except ImportError:
        return None
    try:
        data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception:
        return None
    mono = data.mean(axis=1).astype(np.float32)
    return resample_linear(mono, sr, target_sr)


async def decode_upload(
    raw: bytes,
    target_sr: int = 16000,
    ffmpeg_bin: str = "ffmpeg",
) -> np.ndarray:
    """异步解码上传的音频（在线程池里跑，避免阻塞事件循环）。"""
    loop = asyncio.get_running_loop()

    if ffmpeg_available(ffmpeg_bin):
        return await loop.run_in_executor(
            None, lambda: decode_with_ffmpeg(raw, target_sr, ffmpeg_bin)
        )

    result = await loop.run_in_executor(None, lambda: decode_wav_fallback(raw, target_sr))
    if result is None:
        raise RuntimeError(
            "容器内未安装 ffmpeg 且 WAV 兜底解码失败。请上传标准 WAV，或在镜像中安装 ffmpeg。"
        )
    logger.warning("ffmpeg 不可用，已使用 soundfile 兜底解码")
    return result


def audio_duration_s(audio: np.ndarray, sr: int) -> float:
    return float(audio.shape[0]) / float(sr) if sr else 0.0
