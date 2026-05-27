from pathlib import Path

from app.models.schemas import Segment, Word
from app.services.subtitles import _fmt_time, to_srt, to_vtt


def _seg(i: int, text: str, start: float, end: float, words=None) -> Segment:
    return Segment(
        segment_id=i, start=start, end=end,
        file_path=Path(f"/tmp/{i}.wav"),
        text=text, is_final=True, words=words or [],
    )


def test_fmt_time_srt_and_vtt():
    assert _fmt_time(0.0) == "00:00:00,000"
    assert _fmt_time(3.5) == "00:00:03,500"
    assert _fmt_time(3661.789) == "01:01:01,789"
    assert _fmt_time(3.5, comma=False) == "00:00:03.500"


def test_srt_without_words_uses_chunk_boundaries():
    segs = [_seg(1, "你好", 0.0, 3.0), _seg(2, "再见", 3.0, 6.0)]
    out = to_srt(segs)
    assert "1\n00:00:00,000 --> 00:00:03,000\n你好" in out
    assert "2\n00:00:03,000 --> 00:00:06,000\n再见" in out


def test_vtt_starts_with_header():
    segs = [_seg(1, "hi", 0.0, 1.0)]
    out = to_vtt(segs)
    assert out.startswith("WEBVTT\n")
    assert "00:00:00.000 --> 00:00:01.000" in out


def test_srt_with_words_groups_into_lines():
    # 8 words spread across 8s; default max_dur=5s & max_chars=28 should split.
    words = [Word(word=f"w{i}", start=float(i), end=float(i) + 0.9) for i in range(8)]
    seg = _seg(1, " ".join(w.word for w in words), 0.0, 8.0, words=words)
    out = to_srt([seg])
    # Should produce >=2 numbered entries.
    assert "1\n" in out and "2\n" in out


def test_skip_errored_segments():
    segs = [
        _seg(1, "ok", 0.0, 2.0),
        Segment(segment_id=2, start=2.0, end=4.0, file_path=Path("/tmp/x"), text="", is_final=True, error="bad"),
        _seg(3, "next", 4.0, 6.0),
    ]
    out = to_srt(segs)
    assert "ok" in out and "next" in out and "bad" not in out
