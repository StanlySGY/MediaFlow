"""The archive index and the upload admission gate.

Both exist because of the same failure mode: work that scales with the archive
or with concurrent clients used to run on the request path, where it could stall
or fill the disk under the live realtime pipeline.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from app.config import Settings
from app.services.history_index import HistoryIndex
from app.services.stream_manager import TaskManager
from app.services.upload_gate import UploadGate


# ---- history index ----


def _write(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def test_index_reuses_unchanged_files(tmp_path, monkeypatch):
    out = tmp_path / "out"
    (out / "state").mkdir(parents=True)
    _write(out / "t1.json", {"task_id": "t1", "status": "done", "text": "第一段", "segments": []})
    _write(out / "state" / "t1.json", {"task_id": "t1", "status": "done", "original_name": "会议.wav"})

    index = HistoryIndex(out, refresh_seconds=0)
    index.refresh(force=True)
    assert [r["task_id"] for r in index.records()] == ["t1"]

    # An unchanged file must not be re-parsed; a changed one must be picked up.
    import app.services.history_index as module

    reads = {"n": 0}
    real_read = module.read_json

    def counting_read(path):
        reads["n"] += 1
        return real_read(path)

    monkeypatch.setattr(module, "read_json", counting_read)
    index.refresh(force=True)
    assert reads["n"] == 0

    _write(out / "t1.json", {"task_id": "t1", "status": "done", "text": "改过了", "segments": []})
    index.refresh(force=True)
    assert reads["n"] == 1
    assert index.records()[0]["text"] == "改过了"


def test_index_searches_the_whole_transcript_not_the_preview(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    long_text = "开头" + "填充" * 400 + "结尾的关键词"
    _write(out / "t1.json", {"task_id": "t1", "status": "done", "text": long_text, "segments": []})

    settings = Settings(temp_dir=tmp_path / "tmp", output_dir=out)
    manager = TaskManager(settings)

    assert manager.list_history(q="开头")["total"] == 1
    # The preview shown in the list is still 200 chars, but search is not
    # limited to it any more.
    assert len(manager.list_history()["tasks"][0]["text"]) == 200
    assert manager.list_history(q="结尾的关键词")["total"] == 1


def test_live_task_is_searchable_past_the_preview(tmp_path):
    """An in-memory task must search on its whole transcript, not the preview.

    The record list shows 200 chars, and `upsert` used to rebuild the haystack
    from that same field — so a just-finished task could not be found by a
    phrase from the middle of it, while the identical task on disk could.
    """
    from app.models.schemas import Segment, TaskResult, TaskStatus
    from app.services.stream_manager import _Task

    out = tmp_path / "out"
    out.mkdir()
    settings = Settings(temp_dir=tmp_path / "tmp", output_dir=out, history_refresh_seconds=0)
    manager = TaskManager(settings)

    long_text = "开头" + "填充" * 200 + "结尾的关键词"
    task = _Task("live1", settings)
    task.original_name = "live.wav"
    task.info.status = TaskStatus.done
    task.result = TaskResult(
        task_id="live1",
        status=TaskStatus.done,
        text=long_text,
        segments=[Segment(segment_id=1, start=0, end=1, file_path=tmp_path / "s.wav", text=long_text)],
    )
    manager._tasks["live1"] = task

    tasks = manager.list_history(q="结尾的关键词")["tasks"]
    assert [t["task_id"] for t in tasks] == ["live1"]
    # The row still carries only the preview.
    assert len(manager.list_history()["tasks"][0]["text"]) == 200
    # And the private full text does not leak into the API response.
    assert "_full_text" not in manager.list_history()["tasks"][0]


def test_index_drops_rows_when_the_files_are_deleted(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    _write(out / "t1.json", {"task_id": "t1", "status": "done", "segments": []})
    index = HistoryIndex(out, refresh_seconds=0)
    index.refresh(force=True)
    assert len(index.records()) == 1

    (out / "t1.json").unlink()
    index.refresh(force=True)
    assert index.records() == []


def test_refresh_is_throttled_unless_forced(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    _write(out / "t1.json", {"task_id": "t1", "status": "done", "segments": []})
    index = HistoryIndex(out, refresh_seconds=60)
    index.refresh()  # first call always runs

    _write(out / "t2.json", {"task_id": "t2", "status": "done", "segments": []})
    index.refresh()
    assert len(index.records()) == 1  # still inside the window

    index.refresh(force=True)
    assert len(index.records()) == 2


async def test_list_history_leaves_the_event_loop_free(tmp_path):
    """A history request must not stall the loop that pumps realtime audio."""
    out = tmp_path / "out"
    out.mkdir()
    for i in range(3000):
        _write(out / f"{i:032x}.json", {"task_id": f"{i:032x}", "status": "done", "text": "x", "segments": []})

    from starlette.concurrency import run_in_threadpool

    settings = Settings(temp_dir=tmp_path / "tmp", output_dir=out, history_refresh_seconds=0)
    manager = TaskManager(settings)

    ticks: list[float] = []

    async def ticker():
        last = time.perf_counter()
        while True:
            await asyncio.sleep(0.005)
            now = time.perf_counter()
            ticks.append(now - last)
            last = now

    # Warm the index so the measured request is a pure read, then call the
    # handler the way the route does (threadpool) while a 5ms ticker runs on the
    # same loop. This is the shape of the real failure: one history request
    # delaying the audio pump for the whole scan.
    await run_in_threadpool(manager.list_history, limit=20)
    monitor = asyncio.get_event_loop().create_task(ticker())
    await asyncio.sleep(0.05)
    await run_in_threadpool(manager.list_history, limit=20)
    await asyncio.sleep(0.05)
    monitor.cancel()

    assert ticks, "ticker never ran"
    # 3000 rows of pure index reads should cost single-digit milliseconds.
    assert max(ticks) < 0.1, f"event loop stalled for {max(ticks) * 1000:.0f} ms"


# ---- upload admission ----


def test_upload_gate_refuses_past_the_cap():
    gate = UploadGate(max_concurrent=1, min_free_bytes=0)
    assert gate.try_acquire() is True
    assert gate.try_acquire() is False
    gate.release()
    assert gate.try_acquire() is True
    assert gate.active == 1


def test_upload_gate_reports_a_full_disk(tmp_path):
    gate = UploadGate(max_concurrent=4, min_free_bytes=10**18)
    refused = gate.check_disk(tmp_path, declared_bytes=1024)
    assert refused is not None
    status, message = refused
    assert status == 507
    assert "磁盘" in message


def test_upload_gate_allows_when_the_disk_check_cannot_run(tmp_path, monkeypatch):
    import app.services.upload_gate as module

    def boom(_path):
        raise OSError("not a real mount")

    monkeypatch.setattr(module.shutil, "disk_usage", boom)
    gate = UploadGate(max_concurrent=4)
    assert gate.check_disk(tmp_path, declared_bytes=1024) is None


# ---- volume permissions ----


def test_volume_check_refuses_to_start_when_a_mount_is_not_writable(tmp_path, caplog):
    """An unprivileged container on a root-owned bind mount must stop and say what to do.

    The alternative is the failure this was written for: the service starts,
    /health answers, the UI loads, and the first upload or config save gets a
    bare 500 — on site, after delivery.
    """
    import logging

    import pytest

    from app.main import _check_volume_access

    blocked = tmp_path / "blocked"
    blocked.mkdir()
    blocked.chmod(0o500)  # read + execute, no write
    settings = Settings(
        temp_dir=tmp_path / "tmp",
        output_dir=blocked,
        runtime_config_path=tmp_path / "cfg" / "rc.json",
    )
    try:
        with caplog.at_level(logging.ERROR), pytest.raises(RuntimeError) as excinfo:
            _check_volume_access(settings)
        messages = [r.getMessage() for r in caplog.records]
        assert any("outputs" in m and "not writable" in m for m in messages)
        # The fix has to be in the message, otherwise it is just a stack trace.
        assert any("chown -R" in m for m in messages)
        assert "chown -R" in str(excinfo.value)
    finally:
        blocked.chmod(0o700)


def test_volume_check_accepts_writable_mounts(tmp_path):
    from app.main import _check_volume_access

    settings = Settings(
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
        runtime_config_path=tmp_path / "cfg" / "rc.json",
    )
    _check_volume_access(settings)  # must not raise
    assert not list((tmp_path / "out").glob(".write-probe-*"))
