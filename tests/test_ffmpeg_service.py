from __future__ import annotations

import asyncio
import sys
import time

import pytest

from app.services.ffmpeg_service import FFmpegError, _run


async def test_run_times_out_and_kills_process():
    # `sleep 10` far exceeds the 0.2s cap; _run must abort fast, not wait it out.
    t0 = time.monotonic()
    with pytest.raises(FFmpegError, match="timed out"):
        await _run(["sleep", "10"], timeout=0.2)
    assert time.monotonic() - t0 < 5.0  # killed promptly


async def test_run_cancellation_kills_and_reaps_child_process(monkeypatch):
    original_spawn = asyncio.create_subprocess_exec
    spawned = asyncio.Event()
    children = []

    async def capture_child(*args, **kwargs):
        proc = await original_spawn(*args, **kwargs)
        children.append(proc)
        spawned.set()
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_child)
    task = asyncio.create_task(
        _run([sys.executable, "-c", "import time; time.sleep(30)"])
    )
    await asyncio.wait_for(spawned.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert children[0].returncode is not None


async def test_run_completes_within_timeout():
    rc, out, _ = await _run(["sh", "-c", "echo hello"], timeout=10.0)
    assert rc == 0
    assert "hello" in out


async def test_run_without_timeout_still_works():
    rc, out, _ = await _run(["sh", "-c", "echo hi"])
    assert rc == 0
    assert "hi" in out
