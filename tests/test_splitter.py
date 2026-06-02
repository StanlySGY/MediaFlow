import asyncio

from app.services import splitter
from app.services.splitter import _fixed_ranges, _silence_aware_ranges
from app.services.ffmpeg_service import SilenceRange


def test_fixed_no_overlap_exact():
    rs = _fixed_ranges(60.0, 30.0)
    assert rs == [(0.0, 30.0), (30.0, 60.0)]


def test_fixed_with_overlap():
    rs = _fixed_ranges(60.0, 30.0, overlap=5.0)
    assert rs[0] == (0.0, 30.0)
    assert rs[1] == (25.0, 55.0)
    assert rs[-1][1] == 60.0


def test_fixed_short_audio():
    rs = _fixed_ranges(7.5, 30.0)
    assert rs == [(0.0, 7.5)]


def test_fixed_zero_duration():
    assert _fixed_ranges(0.0, 30.0) == []


def test_silence_aware_uses_silence_midpoint():
    # 60s audio, target chunk 30s, silence around 29s → cut should snap to 29.0
    silences = [SilenceRange(28.5, 29.5)]
    rs = _silence_aware_ranges(60.0, 30.0, silences)
    assert rs[0][0] == 0.0
    assert abs(rs[0][1] - 29.0) < 1e-6
    assert rs[-1][1] == 60.0


def test_silence_aware_falls_back_when_no_silence_in_window():
    rs = _silence_aware_ranges(90.0, 30.0, silences=[])
    # Should behave like fixed cut at exact boundaries.
    assert rs[0] == (0.0, 30.0)
    assert rs[1] == (30.0, 60.0)
    assert rs[2] == (60.0, 90.0)


def test_silence_aware_ignores_silence_too_close_to_cursor():
    silences = [SilenceRange(0.1, 0.3)]  # before window
    rs = _silence_aware_ranges(60.0, 30.0, silences)
    assert rs[0][1] == 30.0


async def test_split_caps_concurrent_ffmpeg(monkeypatch, tmp_path):
    """split() must never run more than ffmpeg_concurrency slice processes at once."""
    concurrent = 0
    peak = 0

    async def fake_probe(path, *, timeout=None):
        return 300.0  # 300s / 30s chunk → 10 segments

    async def fake_slice(src, dst, start, end, *, timeout=None):
        nonlocal concurrent, peak
        concurrent += 1
        peak = max(peak, concurrent)
        await asyncio.sleep(0.02)
        concurrent -= 1

    monkeypatch.setattr("app.services.ffmpeg_service.probe_duration", fake_probe)
    monkeypatch.setattr("app.services.ffmpeg_service.slice_segment", fake_slice)

    segs = await splitter.split(
        tmp_path / "in.wav",
        tmp_path / "segs",
        strategy="fixed",
        chunk=30.0,
        overlap=0.0,
        silence_noise_db=-30.0,
        silence_min_duration=0.4,
        ffmpeg_timeout=60.0,
        ffmpeg_concurrency=3,
    )

    assert len(segs) == 10
    assert peak <= 3  # never exceeded the cap
    assert peak >= 2  # but did parallelize up to it
