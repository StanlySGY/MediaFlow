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
from app.services.asr.realtime_base import classify_message
from app.services.asr_monitoring import asr_call_context
from app.services.ffmpeg_service import FFmpegError, normalize_to_wav, probe_duration
from app.services.merger import merge_segments

log = logging.getLogger(__name__)

_TERMINAL = {TaskStatus.done, TaskStatus.failed, TaskStatus.cancelled}
_PUBLIC_STATUS = {
    TaskStatus.pending.value: "queued",
    TaskStatus.preprocessing.value: "processing",
    TaskStatus.splitting.value: "processing",
    TaskStatus.transcribing.value: "processing",
    TaskStatus.merging.value: "processing",
    TaskStatus.done.value: "done",
    TaskStatus.failed.value: "failed",
    TaskStatus.cancelled.value: "cancelled",
}
_INTERRUPTED_ERROR = "服务在任务完成前重启，任务未继续执行"
_INTERRUPTED_HINT = "请重新提交该文件"


class TaskBusy(RuntimeError):
    """Delete was asked for a task whose pipeline is still running."""


def public_status(status: str) -> str:
    return _PUBLIC_STATUS.get(status, status)


class TaskCancelled(Exception):
    """Raised inside the pipeline when the caller asked to stop."""


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


def _empty_record(task_id: str, created_at: float) -> dict:
    return {
        "task_id": task_id,
        "phase": TaskStatus.pending.value,
        "progress": 0.0,
        "total_segments": 0,
        "finished_segments": 0,
        "duration": 0.0,
        "text": "",
        "error": None,
        "error_code": None,
        "hint": None,
        "retryable": False,
        "original_name": "",
        "created_at": created_at,
        "updated_at": created_at,
        "in_memory": False,
    }


def _record_from_state(data: dict, *, mtime: float) -> dict:
    created = float(data.get("created_at") or mtime)
    item = _empty_record(str(data.get("task_id") or ""), created)
    item["phase"] = str(data.get("status") or item["phase"])
    item["progress"] = float(data.get("progress") or 0.0)
    item["total_segments"] = int(data.get("total_segments") or 0)
    item["finished_segments"] = int(data.get("finished_segments") or 0)
    item["duration"] = float(data.get("duration") or 0.0)
    item["text"] = str(data.get("text_preview") or "")
    item["error"] = data.get("error")
    item["error_code"] = data.get("error_code")
    item["hint"] = data.get("hint")
    item["retryable"] = bool(data.get("retryable"))
    item["original_name"] = str(data.get("original_name") or "")
    item["updated_at"] = float(data.get("updated_at") or mtime)
    return item


def _failure_protocol(exc: BaseException) -> tuple[str, str | None, bool]:
    if isinstance(exc, FFmpegError):
        return "audio_invalid", "文件无法解码，请确认音视频格式", False
    code, hint, retryable = classify_message(str(exc))
    if isinstance(exc, ASRError) and code == "internal_error":
        return "provider_rejected", hint or "上游识别失败", True
    return code, hint, retryable


def _record_from_task(task: "_Task") -> dict:
    return {
        "task_id": task.info.task_id,
        "phase": task.info.status.value,
        "progress": task.info.progress,
        "total_segments": task.info.total_segments,
        "finished_segments": task.info.finished_segments,
        "duration": task.result.duration,
        "text": (task.result.text or "")[:200],
        "error": task.info.error,
        "error_code": task.error_code,
        "hint": task.hint,
        "retryable": task.retryable,
        "original_name": task.original_name,
        "created_at": task.created_at,
        "updated_at": time.time(),
        "in_memory": True,
    }


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
        "original_name",
        "created_at",
        "error_code",
        "hint",
        "retryable",
        "cancel_requested",
    )

    def __init__(self, task_id: str, settings: Settings) -> None:
        self.info = TaskInfo(task_id=task_id, status=TaskStatus.pending)
        self.result = TaskResult(task_id=task_id, status=TaskStatus.pending)
        self.events: list[SegmentEvent] = []
        self.subscribers: set[asyncio.Queue[SegmentEvent | None]] = set()
        self.done: asyncio.Event = asyncio.Event()
        self.completed_at: float | None = None
        self.settings: Settings = settings
        self.original_name = ""
        self.created_at = time.time()
        self.error_code: str | None = None
        self.hint: str | None = None
        self.retryable = False
        self.cancel_requested = False

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
        self.recover_interrupted()

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
        task.original_name = original_name
        task.created_at = time.time()
        async with self._lock:
            self._tasks[task_id] = task
        self._checkpoint(task)

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

    def request_cancel(self, task_id: str) -> str:
        """Flag an in-flight task. Returns missing, accepted, or the terminal status."""
        task = self._tasks.get(task_id) or self._rehydrate(task_id)
        if task is None:
            return "missing"
        if task.info.status in _TERMINAL:
            return task.info.status.value
        task.cancel_requested = True
        return "accepted"

    def delete_task(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        if task is not None and not task.done.is_set() and task.info.status not in _TERMINAL:
            raise TaskBusy(task_id)
        had_memory = self._tasks.pop(task_id, None) is not None
        removed = False
        for path in (
            self._settings.output_dir / f"{task_id}.json",
            self._state_path(task_id),
        ):
            if path.is_file():
                path.unlink()
                removed = True
        return had_memory or removed

    def list_history(
        self,
        *,
        q: str = "",
        status: str | None = None,
        since: float | None = None,
        until: float | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> dict:
        records: dict[str, dict] = {}
        state_dir = self._settings.output_dir / "state"
        if state_dir.is_dir():
            for path in state_dir.glob("*.json"):
                data = _read_json(path)
                if not data:
                    continue
                tid = str(data.get("task_id") or path.stem)
                records[tid] = _record_from_state(data, mtime=path.stat().st_mtime)

        out_dir = self._settings.output_dir
        if out_dir.is_dir():
            for path in out_dir.glob("*.json"):
                data = _read_json(path)
                if not data or "task_id" not in data and "status" not in data:
                    continue
                tid = str(data.get("task_id") or path.stem)
                item = records.get(tid) or _empty_record(tid, path.stat().st_mtime)
                text = data.get("text") or ""
                item["phase"] = data.get("status") or item["phase"]
                item["duration"] = data.get("duration") or item["duration"]
                item["text"] = text[:200]
                item["error"] = data.get("error") if data.get("error") is not None else item["error"]
                item["error_code"] = data.get("error_code") or item["error_code"]
                item["hint"] = data.get("hint") if data.get("hint") is not None else item["hint"]
                if data.get("retryable") is not None:
                    item["retryable"] = bool(data["retryable"])
                item["total_segments"] = len(data.get("segments") or []) or item["total_segments"]
                item["finished_segments"] = item["total_segments"]
                if not item["created_at"]:
                    item["created_at"] = path.stat().st_mtime
                records[tid] = item

        for tid, task in self._tasks.items():
            item = records.get(tid) or _empty_record(tid, task.created_at)
            item.update(_record_from_task(task))
            records[tid] = item

        needle = q.strip().lower()
        items = []
        for item in records.values():
            item["status"] = public_status(item["phase"])
            created = item["created_at"] or item["updated_at"]
            if status and item["status"] != status:
                continue
            if since is not None and created < since:
                continue
            if until is not None and created > until:
                continue
            if needle:
                haystack = " ".join(
                    str(item.get(key) or "")
                    for key in ("task_id", "original_name", "text", "error")
                ).lower()
                if needle not in haystack:
                    continue
            items.append(item)

        items.sort(key=lambda item: item["created_at"] or item["updated_at"], reverse=True)
        total = len(items)
        offset = max(0, offset)
        limit = min(200, max(1, limit))
        return {"tasks": items[offset : offset + limit], "total": total}

    # ---- persistence ----

    def recover_interrupted(self) -> int:
        """Mark tasks left queued or processing by a dead process as failed.

        Does not resume ffmpeg or ASR. A restarted process only keeps the status
        so history still shows what happened.
        """
        state_dir = self._settings.output_dir / "state"
        if not state_dir.is_dir():
            return 0
        recovered = 0
        now = time.time()
        for path in state_dir.glob("*.json"):
            data = _read_json(path)
            if not data:
                continue
            if data.get("status") in {s.value for s in _TERMINAL}:
                continue
            tid = str(data.get("task_id") or path.stem)
            data["task_id"] = tid
            data["status"] = TaskStatus.failed.value
            data["error"] = _INTERRUPTED_ERROR
            data["error_code"] = "interrupted"
            data["hint"] = _INTERRUPTED_HINT
            data["retryable"] = True
            data["updated_at"] = now
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            result_path = self._settings.output_dir / f"{tid}.json"
            if not result_path.is_file():
                result = TaskResult(
                    task_id=tid,
                    status=TaskStatus.failed,
                    duration=float(data.get("duration") or 0.0),
                    text=str(data.get("text_preview") or ""),
                    error=_INTERRUPTED_ERROR,
                    error_code="interrupted",
                    hint=_INTERRUPTED_HINT,
                    retryable=True,
                )
                result_path.parent.mkdir(parents=True, exist_ok=True)
                result_path.write_text(result.model_dump_json(indent=2), encoding="utf-8")
            recovered += 1
        if recovered:
            log.warning("marked %d interrupted task(s) as failed", recovered)
        return recovered

    def _state_path(self, task_id: str) -> Path:
        return self._settings.output_dir / "state" / f"{task_id}.json"

    def _checkpoint(self, task: _Task) -> None:
        path = self._state_path(task.info.task_id)
        payload = {
            "task_id": task.info.task_id,
            "status": task.info.status.value,
            "progress": task.info.progress,
            "total_segments": task.info.total_segments,
            "finished_segments": task.info.finished_segments,
            "error": task.info.error,
            "error_code": task.error_code,
            "hint": task.hint,
            "retryable": task.retryable,
            "original_name": task.original_name,
            "created_at": task.created_at,
            "updated_at": time.time(),
            "duration": task.result.duration,
            "text_preview": (task.result.text or "")[:200],
        }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:  # noqa: BLE001
            log.warning("failed to checkpoint task %s", task.info.task_id, exc_info=True)

    def _persist_terminal(self, task: _Task) -> None:
        task.result.error_code = task.error_code
        task.result.hint = task.hint
        task.result.retryable = task.retryable
        task.info.error_code = task.error_code
        task.info.hint = task.hint
        task.info.retryable = task.retryable
        try:
            out = task.settings.output_dir / f"{task.info.task_id}.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(task.result.model_dump_json(indent=2), encoding="utf-8")
        except Exception:  # noqa: BLE001
            log.warning("failed to persist task %s", task.info.task_id, exc_info=True)
        self._checkpoint(task)

    def _raise_if_cancelled(self, task: _Task) -> None:
        if task.cancel_requested:
            raise TaskCancelled()

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
            error_code=result.error_code,
            hint=result.hint,
            retryable=result.retryable,
        )
        task.error_code = result.error_code
        task.hint = result.hint
        task.retryable = bool(result.retryable)
        state = _read_json(self._state_path(task_id)) or {}
        task.original_name = str(state.get("original_name") or "")
        if state.get("created_at"):
            task.created_at = float(state["created_at"])
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
            self._raise_if_cancelled(task)
            task.info.status = TaskStatus.preprocessing
            self._checkpoint(task)
            normalized = work_dir / "input.wav"
            await normalize_to_wav(source_path, normalized, timeout=s.ffmpeg_timeout)
            duration = await probe_duration(normalized, timeout=s.ffmpeg_timeout)
            task.result.duration = duration

            self._raise_if_cancelled(task)
            task.info.status = TaskStatus.splitting
            self._checkpoint(task)
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

            self._raise_if_cancelled(task)
            task.info.status = TaskStatus.transcribing
            self._checkpoint(task)
            await self._transcribe_all(task, segments)

            self._raise_if_cancelled(task)
            task.info.status = TaskStatus.merging
            self._checkpoint(task)
            task.result.text = merge_segments(segments)
            task.result.language = s.asr_language
            task.result.status = TaskStatus.done
            task.info.status = TaskStatus.done
            task.info.progress = 1.0
            self._persist_terminal(task)

        except TaskCancelled:
            log.info("task %s cancelled", task_id)
            task.info.status = TaskStatus.cancelled
            task.info.error = "任务已取消"
            task.error_code = "cancelled"
            task.hint = None
            task.retryable = False
            task.result.status = TaskStatus.cancelled
            task.result.error = "任务已取消"
            self._persist_terminal(task)
        except (FFmpegError, ASRError, Exception) as e:  # noqa: BLE001
            log.exception("task %s failed", task_id)
            code, hint, retryable = _failure_protocol(e)
            task.info.status = TaskStatus.failed
            task.info.error = str(e)
            task.error_code = code
            task.hint = hint
            task.retryable = retryable
            task.result.status = TaskStatus.failed
            task.result.error = str(e)
            self._persist_terminal(task)
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
                if task.cancel_requested:
                    return
                async with sem:
                    t0 = time.perf_counter()
                    last_err: Exception | None = None
                    for attempt in range(s.asr_max_retries + 1):
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
                                    speaker=w.speaker,
                                )
                                for w in res.words
                            ]
                            seg.raw = res.raw
                            seg.is_final = True
                            last_err = None
                            break
                        except ASRError as e:
                            last_err = e
                            if attempt < s.asr_max_retries:
                                delay = s.asr_retry_backoff ** attempt
                                log.warning(
                                    "segment %d attempt %d/%d failed: %s, retrying in %.1fs",
                                    seg.segment_id, attempt + 1, s.asr_max_retries + 1, e, delay,
                                )
                                await asyncio.sleep(delay)
                            else:
                                seg.error = str(e)
                                seg.is_final = True
                                log.warning("segment %d failed after %d attempts: %s",
                                            seg.segment_id, s.asr_max_retries + 1, e)
                    if last_err is not None and not seg.error:
                        seg.error = str(last_err)
                        seg.is_final = True
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
