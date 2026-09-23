from __future__ import annotations

import json
import time

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
