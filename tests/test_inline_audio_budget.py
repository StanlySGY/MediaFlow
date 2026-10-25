from __future__ import annotations

import io
import wave
from pathlib import Path

import pytest

from app.services.asr.base import ASRError
from app.services.asr.inline_budget import check_inline_audio, provider_is_non_streaming
from app.services.asr.realtime_base import classify_message


def _wav(tmp_path: Path, seconds: float, rate: int = 16000) -> Path:
    path = tmp_path / "audio.wav"
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"\x00\x00" * int(rate * seconds))
    path.write_bytes(buf.getvalue())
    return path


def _settings(**kw):
    from app.config import Settings

    return Settings(**kw)


def test_only_the_base64_provider_is_treated_as_non_streaming():
    assert provider_is_non_streaming(_settings(asr_provider="openai_chat_audio"))
    # openai_compat posts a multipart file part from a handle; realtime providers
    # are a different pipeline entirely.
    assert not provider_is_non_streaming(_settings(asr_provider="openai_compat"))
    assert not provider_is_non_streaming(_settings(asr_provider="whisper"))


async def test_audio_over_the_duration_cap_is_refused_before_it_is_read(tmp_path):
    src = _wav(tmp_path, 90.0)
    with pytest.raises(ASRError) as excinfo:
        await check_inline_audio(src, max_seconds=30.0, max_bytes=0)
    message = str(excinfo.value)
    assert "内联音频" in message
    # The refusal has to land on a code the client can act on: a file that is
    # simply too long is not something a retry loop gets past.
    assert classify_message(message) == (
        "resource_limit",
        "本次录音已达到资源上限，请重新开始",
        False,
    )


async def test_audio_over_the_byte_cap_is_refused_even_without_a_duration(tmp_path):
    # Undecodable input -> no readable duration, so bytes are the only lever.
    src = tmp_path / "not-a-wav.wav"
    src.write_bytes(b"RIFF" + b"\x00" * 4096)
    with pytest.raises(ASRError, match="内联音频体积已达上限"):
        await check_inline_audio(src, max_seconds=300.0, max_bytes=1024)


async def test_audio_inside_both_caps_is_accepted(tmp_path):
    src = _wav(tmp_path, 20.0)
    await check_inline_audio(src, max_seconds=300.0, max_bytes=1024 * 1024)


async def test_zero_caps_disable_the_check(tmp_path):
    # `0` means "no cap" in this project's config vocabulary, and a file long
    # enough to trip a real cap proves the disable is doing something.
    src = _wav(tmp_path, 600.0)
    await check_inline_audio(src, max_seconds=0.0, max_bytes=0)


async def test_an_unreadable_duration_is_not_a_refusal(tmp_path):
    # Refusing audio because ffprobe hiccuped would turn a probe failure into a
    # user-visible failure; whether the file decodes is the provider's business.
    src = tmp_path / "fake.wav"
    src.write_bytes(b"RIFFFAKEWAVDATA" * 8)
    await check_inline_audio(src, max_seconds=30.0, max_bytes=0)


async def test_duration_comes_from_the_header_without_a_subprocess(tmp_path, monkeypatch):
    # The file pipeline calls the provider once per segment, so the check has to
    # be nearly free for the 16 kHz mono wav every path normalizes to.
    import app.services.asr.inline_budget as budget

    def explode(*_args, **_kwargs):
        raise AssertionError("must not shell out when the header answers")

    monkeypatch.setattr(budget, "probe_duration", explode)
    src = _wav(tmp_path, 45.0)
    with pytest.raises(ASRError, match="内联音频时长已达上限"):
        await check_inline_audio(src, max_seconds=30.0, max_bytes=0)
