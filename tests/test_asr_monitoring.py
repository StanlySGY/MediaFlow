from __future__ import annotations

from pathlib import Path

import asyncio
import httpx
import pytest
import respx

from app.config import Settings
from app.services.asr import ASRError, create_provider


def _wav(path: Path) -> Path:
    path.write_bytes(b"RIFF$\x00\x00\x00WAVEfmt ")
    return path


@respx.mock
async def test_monitor_records_successful_asr_call(tmp_path: Path):
    from app.services.asr_monitoring import asr_call_context, asr_monitor

    asr_monitor.reset()
    route = respx.post("https://example.test/v1/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={"choices": [{"message": {"content": "真实识别文本"}}]},
        )
    )

    settings = Settings(
        asr_provider="openai_chat_audio",
        asr_base_url="https://example.test/v1",
        asr_api_key="secret",
        asr_model="qwen3-asr-flash",
    )
    async with create_provider(settings) as provider:
        with asr_call_context(
            source="file_task",
            task_id="task-1",
            segment_id=2,
            declared_format="wav",
            detected_format="wav",
            input_bytes=4096,
            audio_duration_ms=1280.0,
        ):
            result = await provider.transcribe(_wav(tmp_path / "a.wav"))

    assert route.called
    assert result.text == "真实识别文本"

    snapshot = asr_monitor.snapshot()
    assert snapshot["summary"]["total"] == 1
    assert snapshot["summary"]["succeeded"] == 1
    assert snapshot["summary"]["failed"] == 0

    call = snapshot["calls"][0]
    assert call["status"] == "ok"
    assert call["provider"] == "openai_chat_audio"
    assert call["model"] == "qwen3-asr-flash"
    assert call["task_id"] == "task-1"
    assert call["segment_id"] == 2
    assert call["source"] == "file_task"
    assert call["text_chars"] == len("真实识别文本")
    assert call["text_preview"] == "真实识别文本"
    assert call["declared_format"] == "wav"
    assert call["detected_format"] == "wav"
    assert call["input_bytes"] == 4096
    assert call["audio_duration_ms"] == 1280.0
    assert call["elapsed_ms"] >= 0


@respx.mock
async def test_monitor_records_failed_asr_call(tmp_path: Path):
    from app.services.asr_monitoring import asr_monitor

    asr_monitor.reset()
    respx.post("https://example.test/v1/chat/completions").mock(
        return_value=httpx.Response(400, text="bad request")
    )

    settings = Settings(
        asr_provider="openai_chat_audio",
        asr_base_url="https://example.test/v1",
        asr_api_key="secret",
        asr_model="qwen3-asr-flash",
    )

    with pytest.raises(ASRError):
        async with create_provider(settings) as provider:
            await provider.transcribe(_wav(tmp_path / "b.wav"))

    snapshot = asr_monitor.snapshot()
    assert snapshot["summary"]["total"] == 1
    assert snapshot["summary"]["succeeded"] == 0
    assert snapshot["summary"]["failed"] == 1
    assert snapshot["calls"][0]["status"] == "error"
    assert "400" in snapshot["calls"][0]["error"]


async def test_monitor_route_includes_runtime_config(monkeypatch):
    from app.api.routes import get_asr_monitor
    from app.services.asr_monitoring import asr_monitor

    asr_monitor.reset()
    settings = Settings(
        asr_provider="openai_chat_audio",
        asr_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        asr_api_key="secret",
        asr_model="qwen3-asr-flash",
        realtime_asr_provider="realtime_offline",
    )
    monkeypatch.setattr("app.api.routes.get_settings", lambda: settings)

    call_id = asr_monitor.start_call(
        provider="openai_chat_audio",
        model="qwen3-asr-flash",
        base_url=settings.asr_base_url,
        request_bytes=1234,
    )
    asr_monitor.finish_call(call_id, ok=True, text_chars=4)

    data = await get_asr_monitor()

    assert data["summary"]["total"] == 1
    assert data["config"] == {
        "provider": "openai_chat_audio",
        "model": "qwen3-asr-flash",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "api_key_set": True,
        "realtime_asr_provider": "realtime_offline",
    }


async def test_monitor_subscriber_receives_call_events():
    from app.services.asr_monitoring import asr_monitor

    asr_monitor.reset()
    subscriber = asr_monitor.subscribe()
    started_task = asyncio.create_task(subscriber.__anext__())
    await asyncio.sleep(0)

    call_id = asr_monitor.start_call(
        provider="openai_chat_audio",
        model="qwen3-asr-flash",
        base_url="https://example.test/v1",
        request_bytes=42,
    )

    started = await asyncio.wait_for(started_task, timeout=1)
    assert started["type"] == "call_started"
    assert started["call"]["call_id"] == call_id
    assert started["call"]["status"] == "running"

    finished_task = asyncio.create_task(subscriber.__anext__())
    asr_monitor.finish_call(call_id, ok=False, error="upstream 500")
    finished = await asyncio.wait_for(finished_task, timeout=1)

    assert finished["type"] == "call_finished"
    assert finished["call"]["call_id"] == call_id
    assert finished["call"]["status"] == "error"
    assert finished["call"]["error"] == "upstream 500"

    await subscriber.aclose()


def test_monitor_drops_evicted_calls_from_update_index():
    from app.services.asr_monitoring import ASRMonitor

    monitor = ASRMonitor(max_calls=1)
    old_id = monitor.start_call(
        provider="openai_chat_audio",
        model="qwen3-asr-flash",
        base_url="https://example.test/v1",
    )
    new_id = monitor.start_call(
        provider="openai_chat_audio",
        model="qwen3-asr-flash",
        base_url="https://example.test/v1",
    )

    monitor.finish_call(old_id, ok=True, text_chars=99)
    monitor.finish_call(new_id, ok=True, text_chars=4)

    snapshot = monitor.snapshot()
    assert snapshot["summary"]["total"] == 1
    assert snapshot["calls"][0]["call_id"] == new_id
    assert snapshot["calls"][0]["text_chars"] == 4
