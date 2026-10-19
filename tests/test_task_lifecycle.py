from __future__ import annotations

import asyncio
import json
import os
import time

import pytest

from fastapi.testclient import TestClient

from app.config import Settings
from app.models.schemas import TaskStatus
from app.services.asr.realtime_base import RealtimeASRError, classify_message
from app.services.stream_manager import TaskManager, _Task


def test_classify_session_limit_and_timeout():
    code, hint, retryable = classify_message("同时录音已达上限（4 路），请等待他人结束录音后重试")
    assert code == "session_limit"
    assert hint
    assert retryable is True

    err = RealtimeASRError("timed out waiting for server ready frame")
    assert err.code == "provider_timeout"
    assert err.retryable is True


def test_restart_marks_inflight_task_failed(tmp_path):
    settings = Settings(
        asr_api_key="x",
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
    )
    mgr = TaskManager(settings)
    task = _Task("abc", settings)
    task.original_name = "会议.wav"
    task.created_at = time.time()
    task.info.status = TaskStatus.transcribing
    mgr._tasks["abc"] = task
    mgr._checkpoint(task)

    restarted = TaskManager(settings)
    state = json.loads((settings.output_dir / "state" / "abc.json").read_text(encoding="utf-8"))
    assert state["status"] == "failed"
    assert state["error_code"] == "interrupted"
    info = restarted.get_info("abc")
    assert info is not None
    assert info.status == TaskStatus.failed
    assert info.error_code == "interrupted"

    listed = restarted.list_history(q="会议", status="failed")
    assert listed["total"] == 1
    assert listed["tasks"][0]["status"] == "failed"
    assert listed["tasks"][0]["original_name"] == "会议.wav"

    assert restarted.delete_task("abc") is True
    assert restarted.get_info("abc") is None
    assert restarted.list_history()["total"] == 0


def test_cancel_flag_and_delete_refuses_running_task(tmp_path):
    settings = Settings(
        asr_api_key="x",
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
    )
    mgr = TaskManager(settings)
    task = _Task("live", settings)
    task.info.status = TaskStatus.splitting
    mgr._tasks["live"] = task
    assert mgr.request_cancel("live") == "accepted"
    assert task.cancel_requested is True

    from app.services.stream_manager import TaskBusy
    import pytest

    with pytest.raises(TaskBusy):
        mgr.delete_task("live")


def test_expired_terminal_outputs_are_removed_on_startup(tmp_path):
    settings = Settings(
        asr_api_key="x",
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
        output_ttl_seconds=60,
    )
    settings.output_dir.mkdir(parents=True)
    (settings.output_dir / "old.json").write_text(
        json.dumps({"task_id": "old", "status": "done"}), encoding="utf-8"
    )
    state_dir = settings.output_dir / "state"
    state_dir.mkdir()
    (state_dir / "old.json").write_text(
        json.dumps({"task_id": "old", "status": "done"}), encoding="utf-8"
    )
    old = time.time() - 120
    os.utime(settings.output_dir / "old.json", (old, old))
    os.utime(state_dir / "old.json", (old, old))

    TaskManager(settings)

    assert not (settings.output_dir / "old.json").exists()
    assert not (state_dir / "old.json").exists()


@pytest.mark.asyncio
async def test_periodic_cleanup_removes_expired_outputs_without_new_submit(tmp_path):
    settings = Settings(
        asr_api_key="x",
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
        output_ttl_seconds=1,
    )
    manager = TaskManager(settings)
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    output = settings.output_dir / "old.json"
    output.write_text(json.dumps({"task_id": "old", "status": "done"}), encoding="utf-8")
    old = time.time() - 10
    os.utime(output, (old, old))

    await manager.start()
    try:
        await asyncio.sleep(1.1)
        assert not output.exists()
    finally:
        await manager.stop()


def test_metrics_exposition(monkeypatch, tmp_path):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    from app.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app

    client = TestClient(create_app())
    assert client.get("/health").status_code == 200
    body = client.get("/metrics").text
    assert "requests_total" in body
    assert "provider_calls_total" in body
    assert "active_tasks" in body
    assert "active_realtime_sessions" in body
    assert 'path="/health"' in body


def test_realtime_archive_is_listed_filtered_and_deletable(tmp_path):
    """A realtime recording is filed as a plain archive record, so the history
    list, its status filter and DELETE all have to treat it like a file task."""
    settings = Settings(
        asr_api_key="x",
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
    )
    settings.output_dir.mkdir(parents=True)
    (settings.output_dir / "rt1.json").write_text(
        json.dumps(
            {
                "task_id": "rt1",
                "kind": "realtime",
                "status": "done",
                "session_status": "done",
                "duration": 42.5,
                "language": "zh",
                "text": "这是一段实时录音的识别结果",
                "segments": [],
                "error": None,
                "error_code": None,
                "hint": None,
                "retryable": None,
                "original_name": "实时录音 2026-10-19 10:30",
                "created_at": time.time(),
                "updated_at": time.time(),
                "chunks_received": 12,
                "bytes_received": 4096,
                "events_total": 6,
            }
        ),
        encoding="utf-8",
    )
    (settings.output_dir / "rt2.json").write_text(
        json.dumps(
            {
                "task_id": "rt2",
                "kind": "realtime",
                "status": "cancelled",
                "session_status": "closed",
                "text": "半途结束的录音",
                "segments": [],
                "created_at": time.time(),
                "updated_at": time.time(),
            }
        ),
        encoding="utf-8",
    )

    mgr = TaskManager(settings)
    all_tasks = mgr.list_history()
    ids = {t["task_id"] for t in all_tasks["tasks"]}
    assert {"rt1", "rt2"} <= ids

    by_q = mgr.list_history(q="实时录音")
    assert by_q["total"] == 1
    assert by_q["tasks"][0]["task_id"] == "rt1"
    # `kind` reaches the client untouched: /tasks returns the manager dict as-is.
    assert by_q["tasks"][0]["kind"] == "realtime"
    assert by_q["tasks"][0]["status"] == "done"
    assert by_q["tasks"][0]["total_segments"] == 0

    by_status = mgr.list_history(status="cancelled")
    assert [t["task_id"] for t in by_status["tasks"]] == ["rt2"]

    # The result endpoint rehydrates from the same file (segments:[] keeps the
    # pydantic Segment contract satisfiable).
    result = mgr.get_result("rt1")
    assert result is not None
    assert result.status == TaskStatus.done
    assert result.text == "这是一段实时录音的识别结果"
    assert result.segments == []

    assert mgr.delete_task("rt1") is True
    assert mgr.get_result("rt1") is None
    assert mgr.list_history(q="实时录音")["total"] == 0
