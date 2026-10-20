from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings
from app.models.schemas import Segment, SegmentEvent, TaskResult, TaskStatus
from app.services import stream_manager
from app.services.asr.base import ASRResult
from app.services.stream_manager import TaskManager, _Task


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        asr_api_key="x",
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
        max_tasks_in_memory=3,
        task_ttl_seconds=3600,
    )


def _stub_settings() -> Settings:
    return Settings(asr_api_key="x")


async def test_submit_rejects_invalid_overrides_before_registering_task(settings, tmp_path):
    manager = TaskManager(settings)
    source = tmp_path / "source.wav"
    source.write_bytes(b"audio")

    with pytest.raises(ValidationError):
        await manager.submit(
            source,
            "source.wav",
            overrides={"split_strategy": "overlap", "split_chunk_seconds": 10, "split_overlap_seconds": 10},
        )

    assert manager._tasks == {}
    assert not manager._bg
    assert source.exists()


def _evt(i: int) -> SegmentEvent:
    return SegmentEvent(task_id="t", segment_id=i, start=0, end=1, text=f"seg{i}", is_final=True)


async def test_subscriber_replays_history_and_then_lives():
    task = _Task("t", _stub_settings())
    task.publish(_evt(1))
    task.publish(_evt(2))

    received: list[int] = []
    gen = task.subscribe()

    async def consume():
        async for e in gen:
            received.append(e.segment_id)

    consumer = asyncio.create_task(consume())
    await asyncio.sleep(0)  # let consumer subscribe + drain replay
    task.publish(_evt(3))
    await asyncio.sleep(0)
    task.complete()
    await consumer

    assert received == [1, 2, 3]


async def test_multiple_subscribers_each_get_all_events():
    task = _Task("t", _stub_settings())
    task.publish(_evt(1))

    out_a: list[int] = []
    out_b: list[int] = []

    async def consume(out):
        async for e in task.subscribe():
            out.append(e.segment_id)

    a = asyncio.create_task(consume(out_a))
    b = asyncio.create_task(consume(out_b))
    await asyncio.sleep(0)
    task.publish(_evt(2))
    await asyncio.sleep(0)
    task.complete()
    await asyncio.gather(a, b)

    assert out_a == [1, 2]
    assert out_b == [1, 2]


async def test_late_subscriber_on_completed_task_exits_immediately():
    task = _Task("t", _stub_settings())
    task.publish(_evt(1))
    task.publish(_evt(2))
    task.complete()

    received: list[int] = []
    async for e in task.subscribe():
        received.append(e.segment_id)
    assert received == [1, 2]


async def test_rehydrate_from_disk(settings: Settings):
    mgr = TaskManager(settings)
    settings.output_dir.mkdir(parents=True, exist_ok=True)
    result = TaskResult(task_id="abc", status=TaskStatus.done, duration=12.0, text="hi", segments=[])
    (settings.output_dir / "abc.json").write_text(result.model_dump_json(), encoding="utf-8")

    assert "abc" not in mgr._tasks
    info = mgr.get_info("abc")
    assert info is not None and info.status == TaskStatus.done
    res = mgr.get_result("abc")
    assert res is not None and res.text == "hi"
    # Stream of a rehydrated terminal task should exit cleanly with no events.
    received = [e async for e in mgr.stream("abc")]
    assert received == []


def test_recover_interrupted_repairs_malformed_state_file(settings: Settings):
    state_dir = settings.output_dir / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "broken-task.json").write_text("{incomplete", encoding="utf-8")

    TaskManager(settings)

    state = stream_manager._read_json(state_dir / "broken-task.json")
    result = stream_manager._read_json(settings.output_dir / "broken-task.json")
    assert state is not None
    assert state["task_id"] == "broken-task"
    assert state["status"] == TaskStatus.failed.value
    assert state["error_code"] == "interrupted"
    assert result is not None
    assert result["status"] == TaskStatus.failed.value


def test_checkpoint_write_replaces_json_atomically(settings: Settings, monkeypatch):
    manager = TaskManager(settings)
    task = _Task("atomic-task", settings)
    manager._checkpoint(task)

    state_path = settings.output_dir / "state" / "atomic-task.json"
    assert stream_manager._read_json(state_path) is not None
    assert list(state_path.parent.glob("*.tmp")) == []


def test_recovery_does_not_overwrite_state_when_read_fails(settings: Settings, monkeypatch):
    state_dir = settings.output_dir / "state"
    state_dir.mkdir(parents=True)
    path = state_dir / "unreadable-task.json"
    original = '{"task_id":"unreadable-task","status":"transcribing"}'
    path.write_text(original, encoding="utf-8")
    original_read_text = Path.read_text

    def fail_for_state_file(self, *args, **kwargs):
        if self == path:
            raise PermissionError("temporary read failure")
        return original_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fail_for_state_file)
    TaskManager(settings)
    monkeypatch.setattr(Path, "read_text", original_read_text)

    assert path.read_text(encoding="utf-8") == original


async def test_pipeline_directory_creation_failure_is_persisted(settings: Settings, monkeypatch):
    manager = TaskManager(settings)
    task = _Task("mkdir-failure", settings)
    task.original_name = "source.wav"
    manager._tasks[task.info.task_id] = task
    source = settings.temp_dir / "source.wav"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"audio")
    original_mkdir = Path.mkdir
    work_dir = settings.temp_dir / task.info.task_id

    def fail_for_work_dir(self, *args, **kwargs):
        if self == work_dir:
            raise PermissionError("temporary directory creation failure")
        return original_mkdir(self, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", fail_for_work_dir)
    await manager._run(task.info.task_id, source, "source.wav")

    assert task.info.status == TaskStatus.failed
    assert task.done.is_set()
    assert task.result.error
    assert (settings.output_dir / f"{task.info.task_id}.json").is_file()

async def test_eviction_keeps_inflight_tasks(settings: Settings):
    mgr = TaskManager(settings)
    # 3 completed + 1 in-flight; max_tasks_in_memory=3 → 1 completed should be evicted.
    for i in range(3):
        t = _Task(f"done{i}", _stub_settings())
        t.complete()
        mgr._tasks[t.info.task_id] = t
    inflight = _Task("running", _stub_settings())
    mgr._tasks["running"] = inflight

    mgr._evict_if_needed()

    assert "running" in mgr._tasks
    assert sum(1 for tid in mgr._tasks if tid.startswith("done")) == 2


def _segment(segment_id: int) -> Segment:
    return Segment(
        segment_id=segment_id,
        start=0,
        end=1,
        file_path=Path(f"/tmp/segment-{segment_id}.wav"),
    )


async def test_asr_call_limit_is_shared_across_tasks(settings: Settings, monkeypatch):
    settings.asr_concurrency = 2
    manager = TaskManager(settings)

    class Provider:
        active = 0
        peak = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def transcribe(self, _file_path):
            self.active += 1
            self.peak = max(self.peak, self.active)
            await asyncio.sleep(0.01)
            self.active -= 1
            return ASRResult(text="recognized")

    provider = Provider()

    @asynccontextmanager
    async def create_provider(_settings):
        yield provider

    monkeypatch.setattr(stream_manager, "create_provider", create_provider)
    first = _Task("first", settings)
    second = _Task("second", settings)
    await asyncio.gather(
        manager._transcribe_all(first, [_segment(1), _segment(2)]),
        manager._transcribe_all(second, [_segment(3), _segment(4)]),
    )

    assert provider.peak == settings.asr_concurrency
    assert first.info.finished_segments + second.info.finished_segments == 4


async def test_cancelled_task_waiting_for_asr_slot_does_not_call_provider(
    settings: Settings, monkeypatch
):
    settings.asr_concurrency = 1
    manager = TaskManager(settings)
    first_started = asyncio.Event()
    release_first = asyncio.Event()

    class Provider:
        calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def transcribe(self, _file_path):
            self.calls += 1
            if self.calls == 1:
                first_started.set()
                await release_first.wait()
            return ASRResult(text="recognized")

    provider = Provider()

    @asynccontextmanager
    async def create_provider(_settings):
        yield provider

    monkeypatch.setattr(stream_manager, "create_provider", create_provider)
    first = _Task("first", settings)
    queued = _Task("queued", settings)
    first_run = asyncio.create_task(manager._transcribe_all(first, [_segment(1)]))
    await first_started.wait()
    queued_run = asyncio.create_task(manager._transcribe_all(queued, [_segment(2)]))
    await asyncio.sleep(0.01)
    queued.cancel_requested = True
    release_first.set()
    await asyncio.gather(first_run, queued_run)

    assert provider.calls == 1
