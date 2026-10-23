"""In-memory index over the on-disk task archive.

History used to be rebuilt on every request: `list_history` walked `outputs/`
and `outputs/state/`, parsed every JSON file, filtered and sorted the lot, then
sliced the page. At 20k archived tasks that is ~600ms of synchronous work
inside an `async def` route, so the event loop — and with it every in-flight
realtime recording, which pushes audio every 200ms — stalled for the whole scan.

This module keeps the parsed records in memory and only re-reads a file when its
stat signature changed. Callers get a cheap snapshot; the expensive part
(reading + parsing) happens once per file, not once per request.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

log = logging.getLogger(__name__)

# Full transcripts are kept for search, but a single pathological file must not
# pin an unbounded amount of memory. 8000 chars is roughly half an hour of
# speech; longer transcripts are searchable up to that point and the row preview
# (200 chars) is unaffected.
SEARCH_TEXT_LIMIT = 8000


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def _signature(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


class HistoryIndex:
    """Cached view of `output_dir/*.json` plus `output_dir/state/*.json`."""

    def __init__(self, output_dir: Path, *, refresh_seconds: float = 1.0) -> None:
        self._output_dir = output_dir
        self._records: dict[str, dict] = {}
        # Per-source signatures, so one unchanged file costs a stat, not a read.
        self._state_sig: dict[str, tuple[int, int]] = {}
        self._result_sig: dict[str, tuple[int, int]] = {}
        # Even a signature-only pass costs one stat per archived file (40k stats
        # at 20k tasks ≈ 100ms), so it is throttled. Writers call invalidate()
        # so the next request re-scans — on its threadpool, not on the loop.
        self._refresh_seconds = refresh_seconds
        # None, not 0.0: `monotonic()` counts from an arbitrary point, and on a
        # freshly booted machine it can be smaller than refresh_seconds — a 0.0
        # "never refreshed" sentinel then throttles the very first refresh away
        # and the archive reads as empty.
        self._last_refresh: float | None = None

    # ---- building ----

    def refresh(self, *, force: bool = False) -> None:
        """Re-read only the files whose signature changed since the last call."""
        now = time.monotonic()
        if not force and self._last_refresh is not None and now - self._last_refresh < self._refresh_seconds:
            return
        self._last_refresh = now
        self._refresh_state()
        self._refresh_results()

    def _refresh_state(self) -> None:
        state_dir = self._output_dir / "state"
        seen: set[str] = set()
        for task_id, sig, path in _scan(state_dir):
            seen.add(task_id)
            if self._state_sig.get(task_id) == sig:
                continue
            data = read_json(path)
            self._state_sig[task_id] = sig
            if not data:
                continue
            record = self._records.get(task_id)
            if record is None:
                record = _new_record(task_id, _mtime(path))
                self._records[task_id] = record
            _apply_state(record, data, mtime=_mtime(path))
        for task_id in set(self._state_sig) - seen:
            # The state file is gone (expired or deleted). The result file, if
            # any, keeps the row alive; _refresh_results drops it otherwise.
            self._state_sig.pop(task_id, None)

    def _refresh_results(self) -> None:
        seen: set[str] = set()
        for task_id, sig, path in _scan(self._output_dir):
            if self._result_sig.get(task_id) == sig:
                seen.add(task_id)
                continue
            data = read_json(path)
            self._result_sig[task_id] = sig
            if not data or ("task_id" not in data and "status" not in data):
                continue
            seen.add(task_id)
            record = self._records.get(task_id)
            if record is None:
                record = _new_record(task_id, _mtime(path))
                self._records[task_id] = record
            _apply_result(record, data, mtime=_mtime(path))
        for task_id in set(self._result_sig) - seen:
            self._result_sig.pop(task_id, None)

        # A row survives only while at least one of its files does.
        for task_id in list(self._records):
            if task_id not in self._state_sig and task_id not in self._result_sig:
                self._records.pop(task_id, None)

    def invalidate(self) -> None:
        """Force the next refresh to run (cheap: no I/O happens here).

        Writers call this instead of `refresh(force=True)` so the scan runs on
        the request's threadpool rather than on whichever coroutine finished a
        task and would otherwise block the event loop.
        """
        self._last_refresh = None

    # ---- mutation from live tasks ----

    def upsert(self, record: dict) -> None:
        """Insert or replace a record for an in-memory task.

        `record` may carry the task's full transcript under `_full_text`; the
        row's own `text` is the 200-char preview, and building the search
        haystack from that alone would make a live task unsearchable past its
        first 200 characters — exactly the gap this index exists to close.
        """
        task_id = str(record.get("task_id") or "")
        if not task_id:
            return
        existing = self._records.get(task_id) or _new_record(task_id, record.get("created_at") or time.time())
        full_text = record.get("_full_text")
        existing.update(record)
        existing["_search"] = _haystack(existing, full_text=full_text)
        self._records[task_id] = existing

    def remove(self, task_id: str) -> None:
        self._records.pop(task_id, None)
        self._state_sig.pop(task_id, None)
        self._result_sig.pop(task_id, None)

    # ---- reading ----

    def records(self) -> list[dict]:
        """Public records (private `_`-prefixed keys stripped).

        Copies are shallow: rows are treated as immutable between refreshes, and
        this runs once per request over the whole archive.
        """
        return [
            {k: v for k, v in rec.items() if k[0] != "_"} for rec in self._records.values()
        ]

    def search_text(self, task_id: str) -> str:
        record = self._records.get(task_id)
        return str(record.get("_search", "")) if record else ""

    def __len__(self) -> int:
        return len(self._records)


def _scan(directory: Path):
    """Yield (task_id, signature, path) for `*.json`, using one scandir pass.

    `Path.glob` + `Path.stat` costs ~2x this at 20k files because it builds a
    Path and re-stats per entry; this is the whole cost of a throttled refresh.
    """
    try:
        entries = os.scandir(directory)
    except OSError:
        return
    with entries:
        for entry in entries:
            name = entry.name
            if not name.endswith(".json") or name.startswith("."):
                continue
            try:
                st = entry.stat()
            except OSError:
                continue
            yield name[:-5], (st.st_mtime_ns, st.st_size), directory / name


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return time.time()


def _new_record(task_id: str, created_at: float) -> dict:
    return {
        "task_id": task_id,
        "phase": "pending",
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
        "kind": "file",
        "_search": "",
    }


def _apply_state(record: dict, data: dict, *, mtime: float) -> None:
    created = float(data.get("created_at") or mtime)
    if created:
        record["created_at"] = created
    record["phase"] = str(data.get("status") or record["phase"])
    record["progress"] = float(data.get("progress") or 0.0)
    record["total_segments"] = int(data.get("total_segments") or 0)
    record["finished_segments"] = int(data.get("finished_segments") or 0)
    record["duration"] = float(data.get("duration") or 0.0)
    record["text"] = str(data.get("text_preview") or "")
    record["error"] = data.get("error")
    record["error_code"] = data.get("error_code")
    record["hint"] = data.get("hint")
    record["retryable"] = bool(data.get("retryable"))
    record["original_name"] = str(data.get("original_name") or "")
    record["updated_at"] = float(data.get("updated_at") or mtime)
    # The state file only carries a 200-char preview; the full text, when it
    # exists, comes from the result file in _apply_result.
    record["_search"] = _haystack(record)


def _apply_result(record: dict, data: dict, *, mtime: float) -> None:
    text = str(data.get("text") or "")
    record["phase"] = str(data.get("status") or record["phase"])
    record["duration"] = float(data.get("duration") or record["duration"] or 0.0)
    record["text"] = text[:200]
    if data.get("error") is not None:
        record["error"] = data.get("error")
    if data.get("error_code"):
        record["error_code"] = data.get("error_code")
    if data.get("hint") is not None:
        record["hint"] = data.get("hint")
    if data.get("retryable") is not None:
        record["retryable"] = bool(data["retryable"])
    if data.get("kind"):
        record["kind"] = str(data["kind"])
    segments = data.get("segments") or []
    record["total_segments"] = len(segments) or record["total_segments"]
    record["finished_segments"] = record["total_segments"]
    if not record.get("created_at"):
        record["created_at"] = float(data.get("created_at") or mtime)
    # Search runs over the whole transcript, not the 200-char preview that is
    # displayed. This was the reason a phrase in the middle of a long recording
    # could not be found at all.
    record["_search"] = _haystack(record, full_text=text[:SEARCH_TEXT_LIMIT])


def _haystack(record: dict, *, full_text: str | None = None) -> str:
    parts = [
        str(record.get("task_id") or ""),
        str(record.get("original_name") or ""),
        full_text if full_text is not None else str(record.get("text") or ""),
        str(record.get("error") or ""),
    ]
    return " ".join(parts).lower()
