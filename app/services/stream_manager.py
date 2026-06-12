from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import AsyncIterator

from app.config import Settings
from app.models.schemas import (
    Segment,
    SegmentEvent,
    TaskInfo,
    TaskResult,
    TaskStatus,
    Word,
)
from app.services import splitter
from app.services.asr import ASRError, create_provider
from app.services.asr_monitoring import asr_call_context
from app.services.ffmpeg_service import FFmpegError, normalize_to_wav, probe_duration
from app.services.merger import merge_segments

log = logging.getLogger(__name__)

_TERMINAL = {TaskStatus.done, TaskStatus.failed}


class _Task:
    """Per-task state: events history + subscriber fan-out + termination signal."""

    __slots__ = (
        "info",
        "result",
        "events",
        "subscribers",
        "done",
        "completed_at",
        "settings",
    )

    def __init__(self, task_id: str, settings: Settings) -> None:
        self.info = TaskInfo(task_id=task_id, status=TaskStatus.pending)
        self.result = TaskResult(task_id=task_id, status=TaskStatus.pending)
        self.events: list[SegmentEvent] = []
        self.subscribers: set[asyncio.Queue[SegmentEvent | None]] = set()
        self.done: asyncio.Event = asyncio.Event()
        self.completed_at: float | None = None
        self.settings: Settings = settings

    def publish(self, evt: SegmentEvent) -> None:
        """Append to history and fan out to all live subscribers. Sync only — atomic w.r.t. subscribe()."""
        self.events.append(evt)
        for q in self.subscribers:
            q.put_nowait(evt)

    def complete(self) -> None:
        self.done.set()
        self.completed_at = time.monotonic()
        for q in self.subscribers:
            q.put_nowait(None)

    async def subscribe(self) -> AsyncIterator[SegmentEvent]:
        q: asyncio.Queue[SegmentEvent | None] = asyncio.Queue()
        # Snapshot + register atomically (no await between these statements).
        for e in self.events:
            q.put_nowait(e)
        if self.done.is_set():
            q.put_nowait(None)
        else:
            self.subscribers.add(q)
        try:
            while True:
                evt = await q.get()
                if evt is None:
                    return
                yield evt
        finally:
            self.subscribers.discard(q)


class TaskManager:
    """Owns task lifecycle, segment-level event streaming, persistence, and eviction."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._tasks: dict[str, _Task] = {}
        self._lock = asyncio.Lock()
        self._bg: set[asyncio.Task] = set()

    # ---- lifecycle ----

    async def submit(
        self, source_path: Path, original_name: str, *, overrides: dict | None = None
    ) -> str:
        self._evict_if_needed()
        task_id = uuid.uuid4().hex
        task_settings = (
            self._settings.model_copy(update=overrides) if overrides else self._settings
        )
        task = _Task(task_id, task_settings)
        async with self._lock:
            self._tasks[task_id] = task

        bg = asyncio.create_task(self._run(task_id, source_path, original_name))
        self._bg.add(bg)
        bg.add_done_callback(self._bg.discard)
        return task_id

    def get_info(self, task_id: str) -> TaskInfo | None:
        t = self._tasks.get(task_id) or self._rehydrate(task_id)
        return t.info if t else None

    def get_result(self, task_id: str) -> TaskResult | None:
        t = self._tasks.get(task_id) or self._rehydrate(task_id)
        return t.result if t else None

    async def stream(self, task_id: str) -> AsyncIterator[SegmentEvent]:
        task = self._tasks.get(task_id) or self._rehydrate(task_id)
        if task is None:
            return
        async for evt in task.subscribe():
            yield evt

    # ---- eviction & rehydration ----

    def _evict_if_needed(self) -> None:
        s = self._settings
        now = time.monotonic()
        expired = [
            tid
            for tid, t in self._tasks.items()
            if t.completed_at is not None
            and (now - t.completed_at) > s.task_ttl_seconds
        ]
        for tid in expired:
            self._tasks.pop(tid, None)

        # Bound memory: keep newest by completion time; never evict in-flight tasks.
        if len(self._tasks) > s.max_tasks_in_memory:
            completed = sorted(
                (
                    (tid, t.completed_at)
                    for tid, t in self._tasks.items()
                    if t.completed_at is not None
                ),
                key=lambda x: x[1] or 0.0,
            )
            overflow = len(self._tasks) - s.max_tasks_in_memory
            for tid, _ in completed[:overflow]:
                self._tasks.pop(tid, None)

    def _rehydrate(self, task_id: str) -> _Task | None:
        """Reload a finished task from disk when it's no longer in memory."""
        path = self._settings.output_dir / f"{task_id}.json"
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            result = TaskResult.model_validate(data)
        except Exception:  # noqa: BLE001
            log.warning("failed to rehydrate task %s", task_id, exc_info=True)
            return None

        task = _Task(task_id, self._settings)
        task.result = result
        task.info = TaskInfo(
            task_id=task_id,
            status=result.status,
            progress=1.0 if result.status in _TERMINAL else 0.0,
            total_segments=len(result.segments),
            finished_segments=len(result.segments),
            error=result.error,
        )
        task.done.set()
        task.completed_at = time.monotonic()
        self._tasks[task_id] = task
        return task

    # ---- pipeline ----

    async def _run(self, task_id: str, source_path: Path, original_name: str) -> None:
        task = self._tasks[task_id]
        s = task.settings
        work_dir = s.temp_dir / task_id
        work_dir.mkdir(parents=True, exist_ok=True)

        try:
            task.info.status = TaskStatus.preprocessing
            normalized = work_dir / "input.wav"
            await normalize_to_wav(source_path, normalized, timeout=s.ffmpeg_timeout)
            duration = await probe_duration(normalized, timeout=s.ffmpeg_timeout)
            task.result.duration = duration

            task.info.status = TaskStatus.splitting
            segments = await splitter.split(
                normalized,
                work_dir / "segments",
                strategy=s.split_strategy,
                chunk=s.split_chunk_seconds,
                overlap=s.split_overlap_seconds,
                silence_noise_db=s.silence_noise_db,
                silence_min_duration=s.silence_min_duration,
                ffmpeg_timeout=s.ffmpeg_timeout,
                ffmpeg_concurrency=s.ffmpeg_concurrency,
            )
            task.info.total_segments = len(segments)
            task.result.segments = segments

            task.info.status = TaskStatus.transcribing
            await self._transcribe_all(task, segments)

            task.info.status = TaskStatus.merging
            task.result.text = merge_segments(segments)
            task.result.language = s.asr_language
            task.result.status = TaskStatus.done
            task.info.status = TaskStatus.done
            task.info.progress = 1.0

            out_path = s.output_dir / f"{task_id}.json"
            out_path.write_text(task.result.model_dump_json(indent=2), encoding="utf-8")

        except (FFmpegError, ASRError, Exception) as e:  # noqa: BLE001
            log.exception("task %s failed", task_id)
            task.info.status = TaskStatus.failed
            task.info.error = str(e)
            task.result.status = TaskStatus.failed
            task.result.error = str(e)
            # Persist failure too, so /result survives restart.
            try:
                (s.output_dir / f"{task_id}.json").write_text(
                    task.result.model_dump_json(indent=2),
                    encoding="utf-8",
                )
            except Exception:  # noqa: BLE001
                log.warning("failed to persist failure for %s", task_id, exc_info=True)
        finally:
            task.complete()
            try:
                shutil.rmtree(work_dir, ignore_errors=True)
                if source_path.exists():
                    source_path.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                log.warning("cleanup failed for %s", task_id, exc_info=True)

    async def _transcribe_all(self, task: _Task, segments: list[Segment]) -> None:
        s = task.settings
        sem = asyncio.Semaphore(max(1, s.asr_concurrency))

        async with create_provider(s) as provider:

            async def worker(seg: Segment) -> None:
                async with sem:
                    t0 = time.perf_counter()
                    try:
                        with asr_call_context(
                            source="file_task",
                            task_id=task.info.task_id,
                            segment_id=seg.segment_id,
                        ):
                            res = await provider.transcribe(seg.file_path)
                        seg.text = res.text
                        seg.words = [
                            Word(
                                word=w.word,
                                start=w.start + seg.start,
                                end=w.end + seg.start,
                            )
                            for w in res.words
                        ]
                        seg.raw = res.raw
                        seg.is_final = True
                    except ASRError as e:
                        seg.error = str(e)
                        seg.is_final = True
                        log.warning("segment %d failed: %s", seg.segment_id, e)
                    finally:
                        seg.elapsed_ms = (time.perf_counter() - t0) * 1000.0
                        task.info.finished_segments += 1
                        if task.info.total_segments:
                            task.info.progress = (
                                task.info.finished_segments / task.info.total_segments
                            )
                        task.publish(
                            SegmentEvent(
                                task_id=task.info.task_id,
                                segment_id=seg.segment_id,
                                start=seg.start,
                                end=seg.end,
                                text=seg.text,
                                is_final=seg.is_final,
                                elapsed_ms=seg.elapsed_ms,
                                error=seg.error,
                            )
                        )

            await asyncio.gather(*(worker(seg) for seg in segments))
