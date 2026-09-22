from __future__ import annotations

import asyncio
import base64
import json
import shutil
import subprocess
from typing import Any

import pytest

from app.models.schemas import RealtimeAudioChunk, RealtimeSessionCreate
from app.services.asr.realtime_base import RealtimeASRError
from app.services.asr.realtime_ws import RealtimeWSProvider, _normalize_language


class _FakeWebSocket:
    def __init__(self, terminal_events: list[dict[str, Any]] | None = None) -> None:
        self.sent: list[str | bytes] = []
        self.closed = False
        self._incoming: asyncio.Queue[str | None] = asyncio.Queue()
        self._incoming.put_nowait(json.dumps({"type": "ready", "session_id": "down-1"}))
        self._terminal_events = terminal_events or []

    async def send(self, data: str | bytes) -> None:
        self.sent.append(data)
        if isinstance(data, str) and json.loads(data).get("type") == "stop":
            for event in self._terminal_events:
                self._incoming.put_nowait(json.dumps(event))

    async def recv(self) -> str:
        value = await self._incoming.get()
        assert value is not None
        return value

    def feed(self, event: dict[str, Any]) -> None:
        self._incoming.put_nowait(json.dumps(event))

    def __aiter__(self) -> "_FakeWebSocket":
        return self

    async def __anext__(self) -> str:
        value = await self._incoming.get()
        if value is None:
            raise StopAsyncIteration
        return value

    async def close(self) -> None:
        self.closed = True
        self._incoming.put_nowait(None)


class _QueueReader:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()

    def feed(self, data: bytes) -> None:
        self._queue.put_nowait(data)

    async def read(self, _size: int = -1) -> bytes:
        return await self._queue.get()


class _FakeStdin:
    def __init__(self, process: "_FakeProcess") -> None:
        self._process = process
        self.writes: list[bytes] = []
        self._closing = False

    def write(self, data: bytes) -> None:
        self.writes.append(data)
        self._process.stdout.feed(b"\x01\x00" * 3200)

    async def drain(self) -> None:
        pass

    def is_closing(self) -> bool:
        return self._closing

    def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        self._process.stdout.feed(b"")
        self._process.stderr.feed(b"")
        self._process.returncode = 0
        self._process.exited.set()

    async def wait_closed(self) -> None:
        pass


class _FakeProcess:
    def __init__(self) -> None:
        self.stdout = _QueueReader()
        self.stderr = _QueueReader()
        self.exited = asyncio.Event()
        self.returncode: int | None = None
        self.stdin = _FakeStdin(self)

    async def wait(self) -> int:
        await self.exited.wait()
        assert self.returncode is not None
        return self.returncode

    def terminate(self) -> None:
        self.stdin.close()

    def kill(self) -> None:
        self.stdin.close()


async def _provider_with_socket(monkeypatch, socket: _FakeWebSocket) -> RealtimeWSProvider:
    async def fake_connect(url: str, **kwargs: Any) -> _FakeWebSocket:
        assert url == "ws://asr.internal:8022/v1/asr/stream"
        fake_connect.kwargs = kwargs
        return socket

    fake_connect.kwargs = {}
    monkeypatch.setattr(
        "app.services.asr.realtime_ws.websockets.connect", fake_connect
    )
    provider = RealtimeWSProvider(
        base_url="http://asr.internal:8022/v1/asr/stream",
        api_key="secret",
    )
    return provider


async def test_pcm_stream_maps_qwen_events_to_cumulative_text(monkeypatch):
    socket = _FakeWebSocket(
        terminal_events=[
            {"type": "partial", "segment_id": 0, "text": "今天"},
            {"type": "delta", "segment_id": 0, "text": "今"},
            {"type": "delta", "segment_id": 0, "text": "天天气"},
            {"type": "final", "segment_id": 0, "text": "今天天气"},
            {"type": "partial", "segment_id": 1, "text": "不错"},
            {"type": "final", "segment_id": 1, "text": "不错"},
            {"type": "done", "text": "今天天气不错", "total_audio_s": 1.2},
        ]
    )
    provider = await _provider_with_socket(monkeypatch, socket)
    provider.bind_session("mediaflow-1")

    async with provider:
        await provider.start(
            RealtimeSessionCreate(
                language="zh",
                sample_rate=16000,
                format="pcm_s16le",
                channels=1,
            )
        )
        pcm = b"\x00\x00" * 3205
        await provider.push_audio(
            RealtimeAudioChunk(
                seq=1,
                audio=base64.b64encode(pcm).decode("ascii"),
                is_final=True,
            )
        )
        events = [event async for event in provider.events()]

    start = json.loads(str(socket.sent[0]))
    assert start == {
        "type": "start",
        "sample_rate": 16000,
        "format": "pcm_s16le",
        "channels": 1,
        "enable_partial": True,
        "enable_vad": True,
        "language": "Chinese",
    }
    binary_frames = [item for item in socket.sent if isinstance(item, bytes)]
    assert [len(item) for item in binary_frames] == [6400, 10]
    assert json.loads(str(socket.sent[-1])) == {"type": "stop"}

    assert [event.type for event in events] == [
        "online", "online", "online", "final", "online", "final", "done"
    ]
    assert events[0].text == "今天"
    assert events[2].text == "今天天气"
    assert events[4].text == "今天天气不错"
    assert events[-2].text == "今天天气不错"
    assert events[-1].text == "今天天气不错"
    assert events[-1].mode == "realtime_ws"
    assert [event.seq for event in events] == list(range(1, len(events) + 1))
    assert all(event.is_final is (event.type in {"final", "done"}) for event in events)


async def test_websocket_error_is_terminal_and_emitted_once(monkeypatch):
    socket = _FakeWebSocket(terminal_events=[{"type": "error", "error": "upstream failed"}])
    provider = await _provider_with_socket(monkeypatch, socket)
    provider.bind_session("mediaflow-error-1")

    async with provider:
        await provider.start(RealtimeSessionCreate())
        await provider.finish()
        events = [event async for event in provider.events()]
        provider._emit_error("late duplicate", payload=None)

    assert [event.type for event in events] == ["error"]
    assert events[0].error == "upstream failed"
    assert events[0].is_final is False
    assert events[0].seq == 1
    assert provider._terminal_received is True


async def test_websocket_disconnect_before_terminal_emits_single_error(monkeypatch):
    socket = _FakeWebSocket(terminal_events=[])
    provider = await _provider_with_socket(monkeypatch, socket)
    provider.bind_session("mediaflow-disconnect-1")

    async with provider:
        await provider.start(RealtimeSessionCreate())
        await provider.finish()
        await socket.close()
        events = [event async for event in provider.events()]

    assert [event.type for event in events] == ["error"]
    assert events[0].error == "websocket closed before done"
    assert events[0].is_final is False
    assert events[0].seq == 1


async def test_websocket_terminal_done_is_not_followed_by_error(monkeypatch):
    socket = _FakeWebSocket(terminal_events=[{"type": "done", "text": "ok"}])
    provider = await _provider_with_socket(monkeypatch, socket)

    async with provider:
        await provider.start(RealtimeSessionCreate())
        await provider.finish()
        events = [event async for event in provider.events()]

    assert [event.type for event in events][-1] == "done"
    assert all(event.type != "error" for event in events)
    assert events[-1].is_final is True


async def test_webm_is_transcoded_to_pcm_before_websocket_send(monkeypatch):
    socket = _FakeWebSocket(
        terminal_events=[
            {"type": "final", "segment_id": 0, "text": "测试成功"},
            {"type": "done", "text": "测试成功"},
        ]
    )
    provider = await _provider_with_socket(monkeypatch, socket)
    process = _FakeProcess()
    captured_args: tuple[str, ...] = ()

    async def fake_subprocess(*args: str, **_kwargs: Any) -> _FakeProcess:
        nonlocal captured_args
        captured_args = args
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_subprocess)

    async with provider:
        await provider.start(
            RealtimeSessionCreate(
                language="zh",
                sample_rate=48000,
                format="webm",
                channels=1,
            )
        )
        webm = b"\x1a\x45\xdf\xa3browser-webm-stream"
        await provider.push_audio(
            RealtimeAudioChunk(
                seq=1,
                audio=base64.b64encode(webm).decode("ascii"),
                format="webm",
            )
        )
        await provider.finish()
        events = [event async for event in provider.events()]

    assert captured_args[0] == "ffmpeg"
    assert captured_args[-1] == "pipe:1"
    assert process.stdin.writes == [webm]
    assert any(
        isinstance(item, bytes) and len(item) == 6400 for item in socket.sent
    )
    assert events[-2].type == "final"
    assert events[-1].type == "done"


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg is not installed")
async def test_real_ffmpeg_emits_pcm_before_recording_stops(monkeypatch, tmp_path):
    webm_path = tmp_path / "live.webm"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-c:a", "libopus", "-f", "webm", str(webm_path),
        ],
        check=True,
        timeout=10,
    )
    webm = webm_path.read_bytes()
    socket = _FakeWebSocket(
        terminal_events=[{"type": "done", "text": ""}]
    )
    provider = await _provider_with_socket(monkeypatch, socket)

    async with provider:
        await provider.start(
            RealtimeSessionCreate(
                language="zh",
                sample_rate=48000,
                format="webm",
                channels=1,
            )
        )
        for seq, offset in enumerate(range(0, len(webm), 4096), start=1):
            data = webm[offset:offset + 4096]
            await provider.push_audio(
                RealtimeAudioChunk(
                    seq=seq,
                    audio=base64.b64encode(data).decode("ascii"),
                    format="webm",
                )
            )
            await asyncio.sleep(0)

        async def wait_for_pcm() -> None:
            while not any(isinstance(item, bytes) for item in socket.sent):
                await asyncio.sleep(0.01)

        await asyncio.wait_for(wait_for_pcm(), timeout=3)
        assert not provider._finished
        await provider.finish()
        events = [event async for event in provider.events()]

    binary_frames = [item for item in socket.sent if isinstance(item, bytes)]
    assert binary_frames
    assert all(0 < len(frame) <= 6400 for frame in binary_frames)
    assert events[-1].type == "done"


async def test_websocket_uses_bearer_auth_and_no_proxy(monkeypatch):
    socket = _FakeWebSocket(
        terminal_events=[{"type": "done", "text": ""}]
    )
    captured: dict[str, Any] = {}

    async def fake_connect(url: str, **kwargs: Any) -> _FakeWebSocket:
        captured["url"] = url
        captured.update(kwargs)
        return socket

    monkeypatch.setattr(
        "app.services.asr.realtime_ws.websockets.connect", fake_connect
    )
    provider = RealtimeWSProvider(
        base_url="https://asr.internal:8022/v1/asr/stream/",
        api_key="abc123",
    )
    async with provider:
        await provider.start(RealtimeSessionCreate(language="auto"))
        await provider.finish()
        _ = [event async for event in provider.events()]

    assert captured["url"] == "wss://asr.internal:8022/v1/asr/stream"
    assert captured["additional_headers"] == [
        ("Authorization", "Bearer abc123")
    ]
    assert captured["proxy"] is None
    assert "language" not in json.loads(str(socket.sent[0]))


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("zh", "Chinese"),
        ("ZH", "Chinese"),
        ("zh-CN", "Chinese"),
        ("en", "English"),
        ("ja", "Japanese"),
        ("Chinese", "Chinese"),
        ("english", "English"),
        ("  zh  ", "Chinese"),
        ("", ""),
        ("klingon", "Klingon"),
    ],
)
def test_normalize_language_maps_iso_codes_to_full_names(given: str, expected: str):
    assert _normalize_language(given) == expected


async def test_start_frame_sends_full_language_name_upstream(monkeypatch):
    socket = _FakeWebSocket(terminal_events=[{"type": "done", "text": ""}])
    provider = await _provider_with_socket(monkeypatch, socket)

    async with provider:
        await provider.start(RealtimeSessionCreate(language="zh"))
        await provider.finish()
        _ = [event async for event in provider.events()]

    assert json.loads(str(socket.sent[0]))["language"] == "Chinese"


async def test_start_frame_carries_partial_throttle_overrides(monkeypatch):
    """partial_interval_ms / min_partial_ms are per-session escape hatches for the
    latency-vs-concurrency tradeoff; absent fields must stay absent upstream."""
    plain = _FakeWebSocket(terminal_events=[{"type": "done", "text": ""}])
    provider = await _provider_with_socket(monkeypatch, plain)
    async with provider:
        await provider.start(RealtimeSessionCreate(language="zh"))
        await provider.finish()
        _ = [event async for event in provider.events()]
    frame = json.loads(str(plain.sent[0]))
    assert "partial_interval_ms" not in frame
    assert "min_partial_ms" not in frame

    tuned = _FakeWebSocket(terminal_events=[{"type": "done", "text": ""}])
    provider = await _provider_with_socket(monkeypatch, tuned)
    async with provider:
        await provider.start(RealtimeSessionCreate(
            language="zh", partial_interval_ms=640, min_partial_ms=480,
        ))
        await provider.finish()
        _ = [event async for event in provider.events()]
    frame = json.loads(str(tuned.sent[0]))
    assert frame["partial_interval_ms"] == 640
    assert frame["min_partial_ms"] == 480


async def test_realtime_session_appears_in_asr_monitor(monkeypatch):
    """Regression: the call-monitor page used to show nothing but the silent
    「测试连接」probe because realtime sessions never entered the monitor."""
    from app.services.asr_monitoring import asr_monitor

    asr_monitor.reset()
    socket = _FakeWebSocket(
        terminal_events=[
            {"type": "final", "segment_id": 0, "text": "今天天气不错"},
            {"type": "done", "text": "今天天气不错"},
        ]
    )
    provider = await _provider_with_socket(monkeypatch, socket)
    provider.bind_session("mediaflow-monitor-1")

    async with provider:
        await provider.start(
            RealtimeSessionCreate(sample_rate=16000, format="pcm_s16le", channels=1)
        )
        call = next(c for c in asr_monitor.snapshot()["calls"] if c["session_id"] == "mediaflow-monitor-1")
        assert call["status"] == "running", "session must be visible while recording"
        assert call["source"] == "realtime_stream"
        assert call["provider"] == "realtime_ws"
        pcm = b"\x00\x00" * 3200  # exactly 400 ms at 16k mono s16le
        await provider.push_audio(
            RealtimeAudioChunk(
                seq=1, audio=base64.b64encode(pcm).decode("ascii"), is_final=True
            )
        )
        _ = [event async for event in provider.events()]

    calls = asr_monitor.snapshot()["calls"]
    assert len(calls) == 1
    record = calls[0]
    assert record["status"] == "ok"
    assert record["text_preview"] == "今天天气不错"
    assert record["text_chars"] == len("今天天气不错")
    assert record["input_bytes"] == 6400
    # 6400 B of s16le mono @16k is exactly 200 ms of audio
    assert 190.0 <= record["audio_duration_ms"] <= 210.0
    assert record["error"] is None


async def test_realtime_connect_failure_is_recorded(monkeypatch):
    from app.services.asr_monitoring import asr_monitor

    asr_monitor.reset()

    async def refusing_connect(url: str, **_kwargs: Any) -> _FakeWebSocket:
        # 4429 (上游并发满) / 4503 (模型未就绪) 都以握手期异常的形式到达
        raise OSError("HTTP 429")

    monkeypatch.setattr(
        "app.services.asr.realtime_ws.websockets.connect", refusing_connect
    )
    provider = RealtimeWSProvider(base_url="http://asr.internal:8022/v1/asr/stream")
    provider.bind_session("mediaflow-monitor-2")

    with pytest.raises(RealtimeASRError, match="failed to open websocket"):
        async with provider:
            pass

    calls = asr_monitor.snapshot()["calls"]
    assert len(calls) == 1
    assert calls[0]["status"] == "error"
    assert calls[0]["session_id"] == "mediaflow-monitor-2"
    assert "failed to open websocket" in calls[0]["error"]


async def test_monitor_finalizes_once_per_session(monkeypatch):
    """done + a later __aexit__ must not double-count the session."""
    from app.services.asr_monitoring import asr_monitor

    asr_monitor.reset()
    socket = _FakeWebSocket(terminal_events=[{"type": "done", "text": "一句话"}])
    provider = await _provider_with_socket(monkeypatch, socket)
    provider.bind_session("mediaflow-monitor-3")
    async with provider:
        await provider.start(RealtimeSessionCreate(sample_rate=16000, format="pcm_s16le"))
        await provider.push_audio(
            RealtimeAudioChunk(seq=1, audio=base64.b64encode(b"\x00\x00" * 3200).decode(), is_final=True)
        )
        _ = [event async for event in provider.events()]

    snapshot = asr_monitor.snapshot()
    assert snapshot["summary"]["total"] == 1
    assert snapshot["summary"]["succeeded"] == 1
    assert snapshot["summary"]["failed"] == 0
