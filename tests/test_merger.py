from pathlib import Path

from app.models.schemas import Segment, Word
from app.services.merger import (
    _dedupe_join,
    merge_segments,
    merged_words,
)


def _seg(i: int, text: str, start: float = 0.0, end: float = 1.0, words=None, error=None) -> Segment:
    return Segment(
        segment_id=i, start=start, end=end,
        file_path=Path(f"/tmp/{i}.wav"),
        text=text, is_final=True, error=error,
        words=words or [],
    )


# --- LCS fallback (no words available) ---

def test_lcs_dedupe_boundary_overlap():
    a = "今天上海天气很好，我们准备"
    b = "我们准备去吃火锅"
    assert _dedupe_join(a, b) == "今天上海天气很好，我们准备去吃火锅"


def test_lcs_falls_back_when_no_overlap():
    assert _dedupe_join("你好", "再见") == "你好再见"


def test_merge_segments_sorts_and_skips_errors():
    segs = [
        _seg(2, "我们准备去吃火锅"),
        _seg(1, "今天上海天气很好，我们准备"),
        _seg(3, "", error="timeout"),
        _seg(4, " 锅很辣"),
    ]
    out = merge_segments(segs)
    assert "今天上海天气很好，我们准备去吃火锅" in out
    assert "锅很辣" in out


# --- Timestamp-aware merging ---

def test_timestamp_merge_cuts_overlap_at_midpoint():
    seg1 = _seg(
        1, "abc def ghi", start=0.0, end=5.0,
        words=[Word(word=w, start=s, end=e) for w, s, e in [
            ("abc", 0.0, 1.0), ("def", 1.0, 3.0), ("ghi", 3.0, 5.0),
        ]],
    )
    # Chunk 2 overlaps chunk 1 starting at 3.0 (so cut midpoint = 4.0).
    # word at 3.5 should be dropped; word at 4.5 kept.
    seg2 = _seg(
        2, "ghi jkl mno", start=3.0, end=8.0,
        words=[Word(word=w, start=s, end=e) for w, s, e in [
            ("ghi", 3.0, 4.0), ("jkl", 4.5, 6.0), ("mno", 6.0, 8.0),
        ]],
    )
    out = merge_segments([seg1, seg2])
    # Should keep abc/def/ghi from seg1 (all start < 4.0), drop seg2's "ghi" (start 3.0 < 4.0),
    # keep "jkl" and "mno"; latin tokens joined with spaces.
    assert out == "abc def ghi jkl mno"


def test_timestamp_merge_handles_cjk_no_space():
    seg1 = _seg(
        1, "今天天气", start=0.0, end=4.0,
        words=[Word(word=c, start=i, end=i + 1) for i, c in enumerate("今天天气")],
    )
    seg2 = _seg(
        2, "天气很好", start=2.0, end=6.0,
        # absolute timestamps for chunk 2 (already offset)
        words=[Word(word=c, start=2 + i, end=3 + i) for i, c in enumerate("天气很好")],
    )
    out = merge_segments([seg1, seg2])
    # Overlap cut midpoint = (2 + 4)/2 = 3.0. seg1 keeps words starting <3 → "今天天",
    # seg2 keeps words starting >=3 → drop "天"(2),"气"(3 borderline) — "气" starts at 3.0
    # which is exactly the cut so it's kept (start >= cut).
    # Expected: 今天天 + 气很好 = 今天天气很好
    assert out == "今天天气很好"


def test_merged_words_returns_absolute_stream_or_empty():
    # without words → empty
    assert merged_words([_seg(1, "hi")]) == []
    seg = _seg(
        1, "a b", start=10.0, end=12.0,
        words=[Word(word="a", start=10.0, end=11.0), Word(word="b", start=11.0, end=12.0)],
    )
    words = merged_words([seg])
    assert [w.word for w in words] == ["a", "b"]
    assert words[0].start == 10.0
