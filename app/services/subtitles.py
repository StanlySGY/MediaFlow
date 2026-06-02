from __future__ import annotations

from app.models.schemas import Segment, Word
from app.services.merger import _join_words, merged_words


def _fmt_time(seconds: float, *, comma: bool = True) -> str:
    if seconds < 0:
        seconds = 0.0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds - h * 3600 - m * 60
    ms = int(round((s - int(s)) * 1000))
    if ms == 1000:  # rounding overflow
        ms = 0
        s = int(s) + 1
    else:
        s = int(s)
    sep = "," if comma else "."
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _group_words(
    words: list[Word],
    *,
    max_chars: int = 28,
    max_dur: float = 5.0,
    max_gap: float = 0.8,
) -> list[list[Word]]:
    lines: list[list[Word]] = []
    buf: list[Word] = []
    for w in words:
        if buf:
            buf_chars = sum(len(x.word) for x in buf)
            cur_end = buf[-1].end
            if (
                w.start - cur_end > max_gap
                or w.end - buf[0].start > max_dur
                or buf_chars + len(w.word) > max_chars
            ):
                lines.append(buf)
                buf = []
        buf.append(w)
    if buf:
        lines.append(buf)
    return lines


def _entries_from_segments(segments: list[Segment]) -> list[tuple[float, float, str]]:
    """Produce subtitle entries. Prefer word-level grouping when available."""
    words = merged_words(segments)
    if words:
        return [
            (line[0].start, line[-1].end, _join_words(line))
            for line in _group_words(words)
            if line
        ]

    ordered = sorted(segments, key=lambda s: s.segment_id)
    return [
        (s.start, s.end, s.text.strip())
        for s in ordered
        if s.text and not s.error
    ]


def to_srt(segments: list[Segment]) -> str:
    parts: list[str] = []
    for i, (start, end, text) in enumerate(_entries_from_segments(segments), start=1):
        if end <= start:
            end = start + 0.1
        parts.append(
            f"{i}\n{_fmt_time(start)} --> {_fmt_time(end)}\n{text}\n"
        )
    return "\n".join(parts)


def to_vtt(segments: list[Segment]) -> str:
    body: list[str] = ["WEBVTT", ""]
    for i, (start, end, text) in enumerate(_entries_from_segments(segments), start=1):
        if end <= start:
            end = start + 0.1
        body.append(str(i))
        body.append(f"{_fmt_time(start, comma=False)} --> {_fmt_time(end, comma=False)}")
        body.append(text)
        body.append("")
    return "\n".join(body)
