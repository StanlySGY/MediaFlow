"""One probe, one size decision, shared by every whole-file ASR path.

Three pipelines end up handing the gateway a complete audio file: the file-task
pipeline (already split), `/asr/transcribe-stream`, and the `realtime_offline`
adapter, which accumulates a whole recording before calling ASR. The latter two
sent one normalized file per provider call — a 2 GiB upload normalizes to about
19 hours of 16 kHz PCM (32 KB/s), and a recording session accumulates to
`realtime_max_session_bytes` — so "one file, one call" is unbounded in file size,
request body size and call duration.

`max_batch_seconds` is the ceiling for a single provider call:
`split_chunk_seconds`, tightened to the inline-audio cap when the configured
provider cannot stream a request body (`openai_chat_audio` sends audio as a
base64 field inside JSON, so a 90 s chunk is 2.88 MB on disk, 3.84 MB of JSON
body, and 19 MB of peak memory).

Over-cap inputs are sliced by the existing splitter, whose cuts are clamped to the
probed duration, so the batch count has a `duration / split_chunk_seconds` upper
bound and memory, body size and provider fan-out all inherit it. Inputs already
under the ceiling go whole: no extra ffmpeg slice processes, no overlap dedupe to
get wrong, and the short files that dominate tests and `/ping` still make exactly
one call.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from app.config import Settings
from app.models.schemas import Segment, Word
from app.services import ffmpeg_service as ff
from app.services import splitter
from app.services.asr.base import ASRResult
from app.services.asr.inline_budget import provider_is_non_streaming
from app.services.asr_monitoring import asr_call_context
from app.services.merger import merge_segments, merged_words

log = logging.getLogger(__name__)


class AllBatchesFailed(RuntimeError):
    """The provider rejected every batch, so there is nothing to merge."""


@dataclass(frozen=True)
class AudioBudget:
    duration_seconds: float | None
    max_batch_seconds: float

    @property
    def probed(self) -> bool:
        return self.duration_seconds is not None

    @property
    def duration_ms(self) -> float | None:
        return None if self.duration_seconds is None else self.duration_seconds * 1000.0

    def over_batch_budget(self) -> bool:
        """True when the file must be sliced to fit one provider call."""
        return bool(
            self.probed
            and self.max_batch_seconds > 0
            and self.duration_seconds > self.max_batch_seconds
        )


def max_batch_seconds(settings: Settings) -> float:
    """Largest audio chunk one provider call may receive.

    Never larger than `split_chunk_seconds`, so this value can be handed straight
    to the splitter, and never larger than the inline cap for a provider that has
    to hold the body in memory. A deployment that sets a tight inline cap gets
    tight batches rather than a config that fails every call.
    """
    chunk = max(1.0, settings.split_chunk_seconds)
    inline = settings.asr_max_inline_audio_seconds
    if provider_is_non_streaming(settings) and inline > 0:
        return min(chunk, inline)
    return chunk


async def probe_audio_budget(src: Path, settings: Settings) -> AudioBudget:
    """Probe `src` once and report the ceiling that applies to it.

    A failed probe yields `duration_seconds=None` rather than an error: the
    provider call is the reliable decoder, and refusing audio because a duration
    read failed would turn an ffprobe hiccup into a user-visible failure. The
    consequence is that split-based bounds are unavailable for that input, which
    is why `openai_chat_audio` keeps a byte cap of its own.
    """
    ceiling = max_batch_seconds(settings)
    try:
        duration = await ff.probe_duration(src, timeout=settings.ffmpeg_timeout)
    except ff.FFmpegError as exc:
        log.warning("duration probe failed for %s: %s", src, exc)
        return AudioBudget(None, ceiling)
    return AudioBudget(duration, ceiling)


async def transcribe_in_batches(
    src: Path,
    budget: AudioBudget,
    settings: Settings,
    *,
    work_dir: Path,
    source: str,
    key: str,
    prompt: str | None,
    transcribe_func: Callable[[Path, str | None], Awaitable[ASRResult]],
    limiter=None,
) -> tuple[str, list[Word], int, int]:
    """Send `src` to `transcribe_func` in provider-sized batches.

    Returns `(merged_text, merged_words, batch_count, failed_count)` and raises
    `AllBatchesFailed` when no batch answered. Merging goes through the same
    `merger` as the file pipeline, so overlap is handled identically: word
    timestamps trimmed at the overlap midpoint when every batch returned
    timestamps, longest-common-substring dedupe otherwise.

    `transcribe_func` is the caller's configured provider call and owns retry
    policy — a second retry layer here would multiply requests. `limiter` is the
    shared `asr_concurrency` cap, so a large file fans out without exceeding it.
    """
    batches = await _batch_ranges(src, budget, settings, work_dir)
    texts: list[str | None] = [None] * len(batches)
    batch_words: list[list[Word]] = [[] for _ in batches]
    failed = 0

    async def worker(index: int, start: float, end: float, path: Path) -> None:
        nonlocal failed
        try:
            async with _call_slot(limiter):
                with asr_call_context(
                    source=source,
                    segment_id=index + 1,
                    audio_duration_ms=(end - start) * 1000.0,
                ):
                    res = await transcribe_func(path, prompt)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001  # one bad batch must not lose the rest
            failed += 1
            log.warning(
                "%s batch %d/%d (%.1f-%.1fs) failed for %s: %s",
                source, index + 1, len(batches), start, end, key, exc,
            )
            return
        texts[index] = res.text
        # Provider timestamps are relative to the batch; the merge step needs them
        # absolute — the same shift the file pipeline applies per segment.
        batch_words[index] = [
            Word(
                word=w.word,
                start=(w.start or 0.0) + start,
                end=(w.end or 0.0) + start,
                speaker=w.speaker,
            )
            for w in res.words
        ]

    # Concurrent, not sequential: a recording long enough to be sliced is long
    # enough that serial calls would take minutes, and the injected limiter is
    # what bounds the burst. Results are index-keyed so merge order is fixed.
    await asyncio.gather(
        *(worker(i, start, end, path) for i, (start, end, path) in enumerate(batches))
    )

    if not any(text is not None for text in texts):
        raise AllBatchesFailed(f"全部 {len(batches)} 个批次识别失败")

    segments = [
        Segment(
            segment_id=index + 1,
            start=start,
            end=end,
            file_path=path,
            text=text,
            words=batch_words[index],
            is_final=True,
        )
        for index, ((start, end, path), text) in enumerate(
            (r, t) for r, t in zip(batches, texts, strict=True) if t is not None
        )
    ]
    return merge_segments(segments), merged_words(segments), len(batches), failed


def _call_slot(limiter):
    """The injected limiter, or a no-op when the caller has none."""
    return limiter if limiter is not None else contextlib.nullcontext()


async def _batch_ranges(
    src: Path,
    budget: AudioBudget,
    settings: Settings,
    work_dir: Path,
) -> list[tuple[float, float, Path]]:
    """Ranges to send, each small enough for one provider call.

    Under the ceiling the file goes whole. Over it the splitter slices it; if the
    splitter finds nothing to cut — a duration so short its cut loop never runs —
    there is genuinely one batch, so the file still goes whole rather than being
    reported as empty.
    """
    duration = budget.duration_seconds or 0.0
    if not budget.over_batch_budget():
        return [(0.0, duration, src)]

    segments = await splitter.split(
        src,
        work_dir / "segments",
        strategy=settings.split_strategy,
        chunk=settings.split_chunk_seconds,
        overlap=settings.split_overlap_seconds,
        silence_noise_db=settings.silence_noise_db,
        silence_min_duration=settings.silence_min_duration,
        ffmpeg_timeout=settings.ffmpeg_timeout,
        ffmpeg_concurrency=settings.ffmpeg_concurrency,
    )
    if not segments:
        return [(0.0, duration, src)]
    return [(seg.start, seg.end, seg.file_path) for seg in segments]
