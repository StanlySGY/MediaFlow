from __future__ import annotations

import asyncio
import io
import wave
from pathlib import Path

import pytest

from app.config import Settings
from app.models.schemas import RealtimeSessionCreate
from app.services import splitter
from app.services.asr.base import ASRError, ASRResult, WordTime
from app.services.asr.call_limiter import ASRCallLimiter, shared_call_limiter
from app.services.asr.realtime_base import RealtimeASRError
from app.services.audio_budget import (
    AllBatchesFailed,
    max_batch_seconds,
    probe_audio_budget,
    transcribe_in_batches,
)
from app.services.stream_transcribe_manager import _failure_protocol


def _wav_bytes(seconds: float) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buf.getvalue()


def _settings(tmp_path: Path, **overrides) -> Settings:
    base = dict(
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
        runtime_config_path=tmp_path / "runtime.json",
        split_strategy="fixed",
        split_chunk_seconds=2.0,
        split_overlap_seconds=0.0,
        asr_concurrency=2,
        ffmpeg_concurrency=2,
    )
    base.update(overrides)
    return Settings(**base)


def _write_wav(path: Path, seconds: float) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_wav_bytes(seconds))
    return path


# ---- the size decision ----------------------------------------------------


def test_max_batch_seconds_follows_the_split_ceiling():
    assert max_batch_seconds(_settings(Path("."))) == 2.0


def test_max_batch_seconds_tightens_for_a_provider_that_cannot_stream():
    settings = _settings(
        Path("."), asr_provider="openai_chat_audio", asr_max_inline_audio_seconds=1.5
    )
    assert max_batch_seconds(settings) == 1.5


def test_max_batch_seconds_ignores_the_inline_cap_for_a_streaming_provider():
    # A multipart provider streams the part from a handle, so the inline cap
    # would only shrink batches it never needed to shrink.
    settings = _settings(
        Path("."), asr_provider="openai_compat", asr_max_inline_audio_seconds=1.0
    )
    assert max_batch_seconds(settings) == 2.0


async def test_probe_reports_duration_and_ceiling(tmp_path: Path):
    src = _write_wav(tmp_path / "six.wav", 6.0)
    budget = await probe_audio_budget(src, _settings(tmp_path))
    assert budget.probed
    assert budget.duration_seconds == pytest.approx(6.0, abs=0.1)
    assert budget.over_batch_budget()


async def test_probe_of_an_undecodable_file_is_not_an_error(tmp_path: Path):
    # Refusing audio because ffprobe hiccuped would turn a probe failure into a
    # user-visible failure; the provider call is the reliable decoder.
    src = tmp_path / "fake.wav"
    src.write_bytes(b"RIFFFAKEWAVDATA" * 8)
    budget = await probe_audio_budget(src, _settings(tmp_path))
    assert not budget.probed
    assert not budget.over_batch_budget()


# ---- whole file vs fan-out -------------------------------------------------


async def test_audio_under_the_ceiling_makes_exactly_one_whole_file_call(tmp_path: Path):
    src = _write_wav(tmp_path / "short.wav", 1.0)
    budget = await probe_audio_budget(src, _settings(tmp_path))
    calls: list[Path] = []

    async def transcribe(path: Path, _prompt):
        calls.append(path)
        return ASRResult(text="短句")

    text, words, batches, failed = await transcribe_in_batches(
        src, budget, _settings(tmp_path),
        work_dir=tmp_path / "work", source="test", key="k",
        prompt=None, transcribe_func=transcribe,
    )
    assert (text, batches, failed) == ("短句", 1, 0)
    assert words == []  # no provider timestamps -> nothing to merge positionally
    assert calls == [src]  # no extra ffmpeg slice process for a file that fits


async def test_over_ceiling_audio_is_sliced_into_bounded_batches(tmp_path: Path):
    src = _write_wav(tmp_path / "six.wav", 6.0)
    settings = _settings(tmp_path)
    budget = await probe_audio_budget(src, settings)
    ranges: list[tuple[float, float]] = []

    async def transcribe(path: Path, _prompt):
        # Each call must receive a slice, not the whole file.
        assert path != src
        ranges.append((path.stat().st_size, 0.0))
        return ASRResult(text=f"批次{len(ranges)}")

    text, _words, batches, failed = await transcribe_in_batches(
        src, budget, settings,
        work_dir=tmp_path / "work", source="test", key="k",
        prompt=None, transcribe_func=transcribe,
    )
    assert failed == 0
    # 6s at a 2s ceiling -> 3 batches. The count is bounded by
    # duration / split_chunk_seconds, which is what caps memory, body size and
    # provider fan-out together.
    assert batches == 3
    assert len(ranges) == 3
    assert all(size < src.stat().st_size for size, _ in ranges)
    assert "批次1" in text and "批次3" in text


async def test_batch_timestamps_are_shifted_to_the_whole_file(tmp_path: Path):
    # The provider answers relative to the batch it received; subtitles need the
    # position inside the original recording.
    src = _write_wav(tmp_path / "six.wav", 6.0)
    settings = _settings(tmp_path)
    budget = await probe_audio_budget(src, settings)

    async def transcribe(path: Path, _prompt):
        # Fixed strategy cuts at 0-2, 2-4, 4-6; the slice files sort in that order.
        return ASRResult(
            text="词",
            words=[WordTime(word="词", start=0.5, end=1.0)],
        )

    _text, words, batches, _failed = await transcribe_in_batches(
        src, budget, settings,
        work_dir=tmp_path / "work", source="test", key="k",
        prompt=None, transcribe_func=transcribe,
    )
    assert batches == 3
    assert len(words) >= 3
    starts = sorted(w.start for w in words)
    # One word per batch, each shifted by its batch start (0 / 2 / 4).
    assert starts[0] == pytest.approx(0.5, abs=0.01)
    assert any(abs(s - 2.5) < 0.01 for s in starts)
    assert any(abs(s - 4.5) < 0.01 for s in starts)
    assert max(starts) < 6.0


async def test_provider_fan_out_stays_under_the_shared_call_cap(tmp_path: Path):
    src = _write_wav(tmp_path / "twelve.wav", 12.0)
    settings = _settings(tmp_path, asr_concurrency=2, ffmpeg_concurrency=4)
    budget = await probe_audio_budget(src, settings)
    limiter = ASRCallLimiter(settings)
    active = 0
    peak = 0

    async def transcribe(_path: Path, _prompt):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        return ASRResult(text="ok")

    _text, _words, batches, _failed = await transcribe_in_batches(
        src, budget, settings,
        work_dir=tmp_path / "work", source="test", key="k",
        prompt=None, transcribe_func=transcribe, limiter=limiter,
    )
    assert batches == 6  # 12s / 2s
    assert peak <= 2  # asr_concurrency, not batch count


async def test_one_failed_batch_does_not_lose_the_others(tmp_path: Path, monkeypatch):
    src = _write_wav(tmp_path / "six.wav", 6.0)
    settings = _settings(tmp_path)
    budget = await probe_audio_budget(src, settings)
    attempts = {"n": 0}

    async def transcribe(_path: Path, _prompt):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise ASRError("upstream 500: boom")
        return ASRResult(text="其余批次")

    text, _words, batches, failed = await transcribe_in_batches(
        src, budget, settings,
        work_dir=tmp_path / "work", source="test", key="k",
        prompt=None, transcribe_func=transcribe,
    )
    assert (batches, failed) == (3, 1)
    assert "其余批次" in text


async def test_every_batch_failing_is_reported_as_such(tmp_path: Path):
    src = _write_wav(tmp_path / "six.wav", 6.0)
    settings = _settings(tmp_path)
    budget = await probe_audio_budget(src, settings)

    async def transcribe(_path: Path, _prompt):
        raise ASRError("upstream 500: boom")

    with pytest.raises(AllBatchesFailed):
        await transcribe_in_batches(
            src, budget, settings,
            work_dir=tmp_path / "work", source="test", key="k",
            prompt=None, transcribe_func=transcribe,
        )


def test_all_batches_failed_maps_to_a_retryable_provider_code():
    # Not internal_error: the caller is owed an "upstream rejected it, ask again"
    # rather than "something broke here".
    code, hint, retryable = _failure_protocol(AllBatchesFailed("全部 3 个批次识别失败"))
    assert (code, retryable) == ("provider_rejected", True)
    assert hint


async def test_a_split_that_finds_nothing_still_sends_the_file_whole(tmp_path: Path, monkeypatch):
    # _silence_aware_ranges cuts nothing below ~0.05s, so split() legitimately
    # returns [] — an empty batch list must not become an empty transcript.
    src = _write_wav(tmp_path / "tiny.wav", 3.0)
    settings = _settings(tmp_path, split_chunk_seconds=1.0)
    budget = await probe_audio_budget(src, settings)
    assert budget.over_batch_budget()

    async def no_ranges(*_args, **_kwargs):
        return []

    monkeypatch.setattr(splitter, "split", no_ranges)
    calls: list[Path] = []

    async def transcribe(path: Path, _prompt):
        calls.append(path)
        return ASRResult(text="整段")

    text, _words, batches, _failed = await transcribe_in_batches(
        src, budget, settings,
        work_dir=tmp_path / "work", source="test", key="k",
        prompt=None, transcribe_func=transcribe,
    )
    assert (text, batches) == ("整段", 1)
    assert calls == [src]


# ---- the refusal a caller can act on ---------------------------------------


async def test_stream_capacity_refusal_carries_both_counters(tmp_path: Path):
    from app.services.stream_transcribe_manager import StreamTranscribeManager

    manager = StreamTranscribeManager(
        _settings(tmp_path, stream_max_sessions=1),
    )
    config = RealtimeSessionCreate(model="test")
    await manager.create_session(tmp_path / "first.wav", config)
    # RealtimeASRError, not ASRError: the capacity refusal is a session failure
    # the manager raises itself, not something a provider raised.
    with pytest.raises(RealtimeASRError) as excinfo:
        await manager.create_session(tmp_path / "second.wav", config)
    err = excinfo.value
    # The code is set explicitly, not inferred: classify_message keys on
    # 同时录音已达上限, and this refusal says 转录.
    assert err.code == "session_limit"
    # "you are the second of two" and "the cap is one" need different answers.
    assert err.details == {"live": 1, "limit": 1}
    assert err.retryable is True


# ---- the cap is one number for the whole app -------------------------------


async def test_one_limiter_caps_two_pipelines_together(tmp_path: Path):
    # Each manager used to hold its own limiter, so asr_concurrency=2 allowed
    # 4 provider calls in flight — exactly the burst the setting exists to stop.
    from app.services.stream_manager import TaskManager
    from app.services.stream_transcribe_manager import StreamTranscribeManager

    settings = _settings(tmp_path, asr_concurrency=2)
    limiter = shared_call_limiter(settings)
    managers = [TaskManager(settings, asr_limiter=limiter), StreamTranscribeManager(settings, asr_limiter=limiter)]
    assert managers[0]._asr_limiter is limiter
    assert managers[1]._asr_limiter is limiter
    # Same instance, so same per-loop counter: all four acquire calls share the cap.
    peak = 0
    active = 0

    async def hold(manager):
        # Through the manager's own attribute, which is what the pipeline uses.
        nonlocal active, peak
        async with manager._asr_limiter:
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.02)
            active -= 1

    await asyncio.gather(*(hold(m) for m in managers for _ in range(2)))
    assert peak <= 2  # private limiters would give peak 4


async def test_the_cap_is_read_at_acquire_time_not_at_construction(tmp_path: Path):
    # asr_concurrency is in the runtime-config allow-list, so a live change to it
    # has to apply to the limiter that was built before the change.
    settings = _settings(tmp_path, asr_concurrency=1)
    limiter = shared_call_limiter(settings)
    active = 0
    peak = 0

    async def hold():
        nonlocal active, peak
        async with limiter:
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.02)
            active -= 1

    settings.asr_concurrency = 3
    await asyncio.gather(*(hold() for _ in range(3)))
    assert peak == 3


def test_the_app_injects_one_limiter_into_every_manager():
    from app.main import create_app

    app = create_app()
    limiter = app.state.asr_call_limiter
    assert app.state.manager._asr_limiter is limiter
    assert app.state.stream_transcribe_manager._asr_limiter is limiter
    # The realtime manager does not hold one directly; it hands the shared one to
    # the providers that fan a session out into several calls.
    assert app.state.realtime_manager._asr_limiter is limiter
