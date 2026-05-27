from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.config import Settings
from app.models.schemas import SegmentEvent, TaskResult, TaskStatus
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


def _evt(i: int) -> SegmentEvent:
    return SegmentEvent(task_id="t", segment_id=i, start=0, end=1, text=f"seg{i}", is_final=True)


async def test_subscriber_replays_history_and_then_lives():
    task = _Task("t")
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
    task = _Task("t")
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
    task = _Task("t")
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


async def test_eviction_keeps_inflight_tasks(settings: Settings):
    mgr = TaskManager(settings)
    # 3 completed + 1 in-flight; max_tasks_in_memory=3 → 1 completed should be evicted.
    for i in range(3):
        t = _Task(f"done{i}")
        t.complete()
        mgr._tasks[t.info.task_id] = t
    inflight = _Task("running")
    mgr._tasks["running"] = inflight

    mgr._evict_if_needed()

    assert "running" in mgr._tasks
    assert sum(1 for tid in mgr._tasks if tid.startswith("done")) == 2
