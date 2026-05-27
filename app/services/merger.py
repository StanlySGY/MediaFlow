from __future__ import annotations

from app.models.schemas import Segment, Word


def _longest_common_substring(a: str, b: str, *, min_len: int = 4) -> tuple[int, int, int]:
    if not a or not b:
        return 0, 0, 0
    n, m = len(a), len(b)
    prev = [0] * (m + 1)
    best_len = best_i = best_j = 0
    for i in range(1, n + 1):
        curr = [0] * (m + 1)
        ai = a[i - 1]
        for j in range(1, m + 1):
            if ai == b[j - 1]:
                curr[j] = prev[j - 1] + 1
                if curr[j] > best_len:
                    best_len = curr[j]
                    best_i = i - curr[j]
                    best_j = j - curr[j]
        prev = curr
    if best_len < min_len:
        return 0, 0, 0
    return best_i, best_j, best_len


def _dedupe_join(prev: str, nxt: str, *, min_overlap: int = 4) -> str:
    if not prev:
        return nxt
    if not nxt:
        return prev
    tail = prev[-200:]
    head = nxt[:200]
    i, j, ln = _longest_common_substring(tail, head, min_len=min_overlap)
    if ln == 0:
        return prev + nxt
    if (i + ln) >= len(tail) - 1 and j <= 1:
        return prev + nxt[j + ln:]
    return prev + nxt


def _is_cjk(ch: str) -> bool:
    if not ch:
        return False
    return (
        "一" <= ch <= "鿿"
        or "぀" <= ch <= "ヿ"
        or "㐀" <= ch <= "䶿"
        or "＀" <= ch <= "￯"
    )


def _join_words(words: list[Word]) -> str:
    out: list[str] = []
    for w in words:
        token = w.word
        if not token:
            continue
        if out:
            prev_last = out[-1][-1] if out[-1] else ""
            curr_first = token[0]
            if not (_is_cjk(prev_last) or _is_cjk(curr_first)):
                if prev_last.isalnum() and curr_first.isalnum():
                    out.append(" ")
        out.append(token)
    return "".join(out).strip()


def _has_usable_words(segments: list[Segment]) -> bool:
    useful = [s for s in segments if not s.error and s.text]
    return bool(useful) and all(s.words for s in useful)


def _merge_with_timestamps(segments: list[Segment]) -> tuple[str, list[Word]]:
    """Use absolute word timestamps to dedupe overlap regions then rejoin."""
    ordered = sorted(segments, key=lambda s: s.segment_id)
    out: list[Word] = []
    for seg in ordered:
        if seg.error or not seg.words:
            continue
        if not out:
            out.extend(seg.words)
            continue
        prev_end = out[-1].end
        if seg.words[0].start < prev_end:
            cut = (seg.words[0].start + prev_end) / 2
            while out and out[-1].start >= cut:
                out.pop()
            for w in seg.words:
                if w.start >= cut:
                    out.append(w)
        else:
            out.extend(seg.words)
    return _join_words(out), out


def _merge_lcs(segments: list[Segment]) -> str:
    ordered = sorted(segments, key=lambda s: s.segment_id)
    out = ""
    for seg in ordered:
        if seg.error or not seg.text:
            continue
        out = _dedupe_join(out, seg.text)
    return out.strip()


def merge_segments(segments: list[Segment]) -> str:
    """Merge segment texts. Uses word timestamps when available, falls back to LCS."""
    if _has_usable_words(segments):
        text, _ = _merge_with_timestamps(segments)
        return text
    return _merge_lcs(segments)


def merged_words(segments: list[Segment]) -> list[Word]:
    """Return deduped absolute-timestamp word stream, or empty if not available."""
    if not _has_usable_words(segments):
        return []
    _, words = _merge_with_timestamps(segments)
    return words
