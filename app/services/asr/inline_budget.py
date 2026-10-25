"""Pre-flight check for providers that must inline the whole audio file.

`openai_chat_audio` puts audio into a JSON body as a base64 data URI, so the
payload has to exist in memory at once and in several copies: file bytes, the
base64 str, the serialized body, and httpx's own buffer — measured 1.33x the
file size, and paid again on every retry. `openai_compat` posts the same file as
a multipart file part and streams it from a handle, so it needs neither check.

Duration is the tighter check in practice and is what an upstream audio model
actually enforces; bytes are the fallback for inputs whose duration cannot be
read. Both are evaluated before the file is read, so an over-cap file is refused
rather than paid for and then sent.
"""
from __future__ import annotations

import wave
from pathlib import Path

from app.config import Settings
from app.services.asr.base import ASRError
from app.services.ffmpeg_service import FFmpegError, probe_duration

# Providers that build a single in-memory request body per call.
NON_STREAMING_PROVIDERS = frozenset({"openai_chat_audio"})


def provider_is_non_streaming(settings: Settings) -> bool:
    """True when the configured file ASR provider cannot stream a request body."""
    return settings.asr_provider in NON_STREAMING_PROVIDERS


def _wav_header_duration_seconds(path: Path) -> float | None:
    """Duration from a RIFF/WAVE header, with no subprocess.

    Every whole-file path in MediaFlow hands the provider a 16 kHz mono
    `pcm_s16le` wav produced by `normalize_to_wav`, so the header is enough and
    the check costs nothing per call — which matters because the file pipeline
    calls the provider once per segment.
    """
    try:
        with wave.open(str(path), "rb") as wf:
            rate = wf.getframerate()
            if rate <= 0:
                return None
            return wf.getnframes() / rate
    except Exception:  # noqa: BLE001  # not a wav, truncated, or unreadable
        return None


async def check_inline_audio(
    file_path: Path,
    *,
    max_seconds: float,
    max_bytes: int,
    timeout: float | None = None,
) -> None:
    """Refuse audio that cannot be inlined, before it is read or encoded.

    The raised message contains `内联音频`, which `classify_message` maps to
    `resource_limit` with `retryable=False`: a caller cannot retry their way past
    a file that is simply too long.

    An unreadable duration is not a refusal — the byte cap is then the only check
    available, and whether the file decodes at all is the provider's business.
    """
    if max_bytes:
        size = file_path.stat().st_size
        if size > max_bytes:
            raise _refusal(f"内联音频体积已达上限（{size} > {max_bytes} bytes）")
    if max_seconds <= 0:
        return
    duration = _wav_header_duration_seconds(file_path)
    if duration is None:
        try:
            duration = await probe_duration(file_path, timeout=timeout)
        except (FFmpegError, ValueError):
            return
    if duration > max_seconds:
        raise _refusal(
            f"内联音频时长已达上限（{duration:.1f} > {max_seconds:.1f} 秒）"
        )


def _refusal(detail: str) -> ASRError:
    return ASRError(
        f"{detail}，该 provider 只能把整段音频作为 base64 内联进 JSON 请求体；"
        "请缩短录音或改用流式上传的 provider"
    )
