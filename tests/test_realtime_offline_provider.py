from __future__ import annotations

import base64
from pathlib import Path

from app.config import Settings
from app.models.schemas import RealtimeAudioChunk, RealtimeSessionCreate
from app.services.asr.base import ASRError, ASRResult, WordTime
from app.services.asr.realtime_offline import RealtimeOfflineProvider


class _FakeOfflineProvider:
    def __init__(self) -> None:
        self.seen_prefixes: list[bytes] = []
        self.prompts: list[str | None] = []

    async def __aenter__(self) -> "_FakeOfflineProvider":
        return self

    async def __aexit__(self, *exc) -> None:
        pass

    async def transcribe(self, file_path, *, prompt: str | None = None) -> ASRResult:
        self.seen_prefixes.append(file_path.read_bytes()[:4])
        self.prompts.append(prompt)
        return ASRResult(text="你好世界，流式返回。")


async def test_realtime_offline_wraps_pcm_chunks_and_streams_simulated_text(tmp_path):
    fake = _FakeOfflineProvider()
    settings = Settings(
        temp_dir=tmp_path,
        asr_api_key="test-key",
        realtime_asr_provider="realtime_offline",
    )
    provider = RealtimeOfflineProvider(settings, provider_factory=lambda _: fake)
    provider.bind_session("s-offline")

    async with provider:
        await provider.start(
            RealtimeSessionCreate(
                sample_rate=16000,
                format="pcm_s16le",
                channels=1,
                prompt_hints="会议录音",
            )
        )
        await provider.push_audio(
            RealtimeAudioChunk(
                seq=1,
                audio=base64.b64encode(b"\x00\x00" * 800).decode("ascii"),
            )
        )
        await provider.push_audio(
            RealtimeAudioChunk(
                seq=2,
                audio=base64.b64encode(b"\x01\x00" * 800).decode("ascii"),
                is_final=True,
            )
        )

        events = [evt async for evt in provider.events()]

    assert fake.seen_prefixes == [b"RIFF"]
    assert fake.prompts == ["会议录音"]
    assert [evt.type for evt in events][-2:] == ["final", "done"]
    assert any(evt.type == "online" and evt.text for evt in events)
    assert events[-2].text == "你好世界，流式返回。"
    assert events[-2].mode == "simulated_streaming"
    assert events[-1].mode == "simulated_streaming"


async def test_realtime_offline_detects_webm_payload_when_session_uses_default_pcm(
    tmp_path,
    monkeypatch,
):
    fake = _FakeOfflineProvider()
    normalized_sources: list[str] = []

    async def fake_normalize_to_wav(src, dst, *, timeout=None):
        normalized_sources.append(src.suffix)
        dst.write_bytes(b"RIFF-normalized-webm")

    monkeypatch.setattr(
        "app.services.asr.realtime_offline.normalize_to_wav",
        fake_normalize_to_wav,
    )

    settings = Settings(
        temp_dir=tmp_path,
        asr_api_key="test-key",
        realtime_asr_provider="realtime_offline",
    )
    provider = RealtimeOfflineProvider(settings, provider_factory=lambda _: fake)
    provider.bind_session("s-webm")

    # Browser MediaRecorder commonly sends audio/webm. If the caller forgets to
    # set session.format, the default is pcm_s16le; the adapter must still avoid
    # wrapping WebM bytes as raw PCM.
    webm_payload = b"\x1a\x45\xdf\xa3webm-data"
    async with provider:
        await provider.start(RealtimeSessionCreate())
        await provider.push_audio(
            RealtimeAudioChunk(
                seq=1,
                audio=base64.b64encode(webm_payload).decode("ascii"),
                is_final=True,
            )
        )
        events = [evt async for evt in provider.events()]

    assert normalized_sources == [".webm"]
    assert fake.seen_prefixes == [b"RIFF"]
    assert events[-2].type == "final"


class _BatchingOfflineProvider:
    """Stands in for a file ASR provider, and records what one session made it do.

    Each call gets a distinct slice file, so the recording arriving as N batches
    is observable rather than asserted from a log line.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[Path, str | None]] = []
        # Sizes have to be taken during the call: finish() deletes the session's
        # whole work dir, slice files included.
        self.sizes: list[int] = []

    async def __aenter__(self) -> "_BatchingOfflineProvider":
        return self

    async def __aexit__(self, *exc) -> None:
        pass

    async def transcribe(self, file_path, *, prompt: str | None = None) -> ASRResult:
        self.calls.append((Path(file_path), prompt))
        self.sizes.append(Path(file_path).stat().st_size)
        index = len(self.calls)
        return ASRResult(
            text=f"第{index}批",
            words=[WordTime(word=f"第{index}批", start=0.1, end=0.4)],
        )


def _pcm_chunk(seconds: float) -> str:
    return base64.b64encode(b"\x00\x00" * int(16000 * seconds)).decode("ascii")


async def _record(tmp_path, settings, provider, *, seconds: float, is_final=True):
    provider.bind_session("s-long")
    async with provider:
        await provider.start(
            RealtimeSessionCreate(sample_rate=16000, format="pcm_s16le", channels=1)
        )
        await provider.push_audio(
            RealtimeAudioChunk(seq=1, audio=_pcm_chunk(seconds), is_final=is_final)
        )
        return [evt async for evt in provider.events()]


async def test_a_long_recording_becomes_several_bounded_provider_calls(tmp_path):
    fake = _BatchingOfflineProvider()
    settings = Settings(
        temp_dir=tmp_path,
        asr_api_key="test-key",
        realtime_asr_provider="realtime_offline",
        asr_provider="openai_compat",
        split_strategy="fixed",
        split_chunk_seconds=2.0,
        split_overlap_seconds=0.0,
    )
    provider = RealtimeOfflineProvider(settings, provider_factory=lambda _: fake)

    # 6 s of 16 kHz mono PCM is 192 KB of input and one 30 s-chunk call before the
    # budget existed; at a 2 s ceiling it is three calls, each over a slice.
    events = await _record(tmp_path, settings, provider, seconds=6.0)

    assert len(fake.calls) == 3
    assert all(path.name.startswith("segment_") for path, _ in fake.calls)
    # 2 s of 16 kHz mono pcm_s16le is 64 KB plus the header, against the 192 KB
    # recording the session accumulated.
    assert all(64_000 < size < 96_000 for size in fake.sizes)
    assert events[-2].type == "final"
    # The realtime contract is cumulative text: one final event, in batch order.
    final = events[-2].text
    assert [final.index(t) for t in ("第1批", "第2批", "第3批")] == sorted(
        final.index(t) for t in ("第1批", "第2批", "第3批")
    )


async def test_a_recording_under_the_ceiling_still_makes_one_whole_call(tmp_path):
    fake = _BatchingOfflineProvider()
    settings = Settings(
        temp_dir=tmp_path,
        asr_api_key="test-key",
        realtime_asr_provider="realtime_offline",
        asr_provider="openai_compat",
        split_strategy="fixed",
        split_chunk_seconds=2.0,
        split_overlap_seconds=0.0,
    )
    provider = RealtimeOfflineProvider(settings, provider_factory=lambda _: fake)

    events = await _record(tmp_path, settings, provider, seconds=1.0)

    assert len(fake.calls) == 1
    # No slice files for a recording that already fits one call.
    assert fake.calls[0][0].name == "input.wav"
    assert events[-2].text == "第1批"


async def test_batch_failure_reports_its_protocol_instead_of_an_empty_transcript(
    tmp_path,
):
    class _AlwaysRejects(_BatchingOfflineProvider):
        async def transcribe(self, file_path, *, prompt: str | None = None) -> ASRResult:
            self.calls.append((Path(file_path), prompt))
            self.sizes.append(Path(file_path).stat().st_size)
            raise ASRError("upstream 400: audio too long")

    fake = _AlwaysRejects()
    settings = Settings(
        temp_dir=tmp_path,
        asr_api_key="test-key",
        realtime_asr_provider="realtime_offline",
        asr_provider="openai_compat",
        split_strategy="fixed",
        split_chunk_seconds=2.0,
        split_overlap_seconds=0.0,
    )
    provider = RealtimeOfflineProvider(settings, provider_factory=lambda _: fake)

    events = await _record(tmp_path, settings, provider, seconds=6.0)

    kinds = [evt.type for evt in events]
    # The sentinel closes the stream right after the error: no final event with an
    # empty transcript, which is what a caller would otherwise archive.
    assert kinds[-1] == "error"
    err = events[-1]
    assert err.error_code == "provider_rejected"
    assert err.retryable is True
    assert err.hint
    assert all(evt.type != "final" for evt in events)
