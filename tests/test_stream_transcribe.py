from __future__ import annotations

import asyncio
import io
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.asr.base import ASRResult
from app.services.asr.realtime_base import RealtimeASRError
from app.models.schemas import RealtimeSessionCreate
from app.services.stream_transcribe_manager import StreamTranscribeManager


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.json"))
    monkeypatch.setenv("ASR_PROVIDER", "openai_compat")
    monkeypatch.setenv("ASR_BASE_URL", "https://example.test/v1")
    monkeypatch.setenv("ASR_API_KEY", "test-key")
    monkeypatch.setenv("ASR_MODEL", "test-model")
    monkeypatch.setenv("REALTIME_ASR_PROVIDER", "realtime_mock")
    from app.config import get_settings
    from app.services import stream_transcribe_manager as stream_module

    class FakeProvider:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def transcribe(self, _path):
            return ASRResult(text="测试转写")

    monkeypatch.setattr(stream_module, "create_provider", lambda _settings: FakeProvider())
    get_settings.cache_clear()
    app = create_app()
    # Enter the context manager so lifespan runs: the transcription worker is
    # owned by a lifespan-scoped supervisor, and without lifespan the test
    # would only exercise the cancelled-task fallback.
    with TestClient(app) as c:
        yield c


def test_create_transcribe_stream_returns_session_id(client):
    wav = _minimal_wav()
    r = client.post(
        "/asr/transcribe-stream",
        files={"file": ("test.wav", io.BytesIO(wav), "audio/wav")},
    )
    assert r.status_code == 200
    data = r.json()
    assert "session_id" in data
    assert data["events_url"].endswith("/events")


def test_transcribe_stream_sse_emits_events(client):
    wav = _minimal_wav()
    r = client.post(
        "/asr/transcribe-stream",
        files={"file": ("test.wav", io.BytesIO(wav), "audio/wav")},
    )
    sid = r.json()["session_id"]

    with client.stream("GET", f"/asr/transcribe-stream/{sid}/events") as resp:
        assert resp.status_code == 200
        lines = list(resp.iter_lines())
        assert len(lines) > 0


async def test_stop_prevents_new_workers_from_spawning_during_shutdown(tmp_path, monkeypatch):
    manager = StreamTranscribeManager(
        Settings(
            temp_dir=tmp_path / "tmp",
            output_dir=tmp_path / "out",
            runtime_config_path=tmp_path / "config.json",
        )
    )
    worker_started = asyncio.Event()
    cancellation_started = asyncio.Event()
    allow_cancellation = asyncio.Event()

    async def waiting_worker(session_id: str) -> None:
        worker_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancellation_started.set()
            await allow_cancellation.wait()
            raise

    monkeypatch.setattr(manager, "_run_transcription", waiting_worker)
    await manager.start()
    config = RealtimeSessionCreate(model="test")
    await manager.create_session(tmp_path / "first.wav", config)
    await asyncio.wait_for(worker_started.wait(), timeout=1)

    stop_task = asyncio.create_task(manager.stop())
    await asyncio.wait_for(cancellation_started.wait(), timeout=1)
    session_rejected = False
    try:
        await manager.create_session(tmp_path / "late.wav", config)
    except RuntimeError:
        session_rejected = True
    finally:
        allow_cancellation.set()
    await asyncio.wait_for(stop_task, timeout=1)

    survivors = [worker for worker in manager._workers if not worker.done()]
    for worker in survivors:
        worker.cancel()
    if survivors:
        await asyncio.gather(*survivors, return_exceptions=True)

    assert session_rejected
    assert not survivors


def _minimal_wav(duration: float = 0.1, sample_rate: int = 16000) -> bytes:
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * int(sample_rate * duration))
    return buf.getvalue()


async def test_cancelled_stream_upload_cleans_partial_temp_file(tmp_path, monkeypatch):
    from app.api import routes

    settings = Settings(
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
        runtime_config_path=tmp_path / "runtime.json",
    )
    settings.temp_dir.mkdir(parents=True)
    monkeypatch.setattr(routes, "get_settings", lambda: settings)

    class _CancelledUpload:
        filename = "cancel.wav"

        async def read(self, _size=-1):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await routes.create_transcribe_stream(
            file=_CancelledUpload(), model=None, language=None, stm=object()
        )

    assert list(settings.temp_dir.iterdir()) == []


async def test_transcribe_session_creation_failure_cleans_uploaded_file(tmp_path, monkeypatch):
    from app.api import routes

    settings = Settings(
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
        runtime_config_path=tmp_path / "runtime.json",
    )
    settings.temp_dir.mkdir(parents=True)
    monkeypatch.setattr(routes, "get_settings", lambda: settings)

    class _Upload:
        filename = "uploaded.wav"

        def __init__(self):
            self._data = io.BytesIO(_minimal_wav())

        async def read(self, size=-1):
            return self._data.read(size)

    class _FailingManager:
        async def create_session(self, file_path, config):
            assert file_path.is_file()
            raise RuntimeError("test create session failure")

    with pytest.raises(RuntimeError, match="test create session failure"):
        await routes.create_transcribe_stream(
            file=_Upload(), model=None, language=None, stm=_FailingManager()
        )

    assert list(settings.temp_dir.iterdir()) == []


async def test_stream_capacity_refusal_is_a_429_and_not_a_500(tmp_path, monkeypatch):
    """The refusal is a `RealtimeASRError`, which is a plain RuntimeError.

    Before it had its own branch it fell into the catch-all below the upload and
    came back as a 500 — the client paid for a whole upload to be told that
    something broke, with no way to know it was only "try again shortly".
    """
    from app.api import routes

    settings = Settings(
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
        runtime_config_path=tmp_path / "runtime.json",
    )
    settings.temp_dir.mkdir(parents=True)
    monkeypatch.setattr(routes, "get_settings", lambda: settings)

    class _Upload:
        filename = "full.wav"

        def __init__(self):
            self._data = io.BytesIO(_minimal_wav())

        async def read(self, size=-1):
            return self._data.read(size)

    class _FullManager:
        async def create_session(self, file_path, config):
            raise RealtimeASRError(
                "同时转录已达上限（2/2 路占用中），正在等待空位",
                code="session_limit",
                hint="正在等待空位",
                retryable=True,
                details={"live": 2, "limit": 2},
            )

    with pytest.raises(HTTPException) as excinfo:
        await routes.create_transcribe_stream(
            file=_Upload(), model=None, language=None, stm=_FullManager()
        )
    exc = excinfo.value
    assert exc.status_code == 429
    assert exc.detail["code"] == "session_limit"
    assert exc.detail["details"] == {"live": 2, "limit": 2}
    assert exc.headers == {"Retry-After": "2"}
    # The upload it paid for is gone either way.
    assert list(settings.temp_dir.iterdir()) == []


async def test_stream_provider_error_still_maps_to_a_422(tmp_path, monkeypatch):
    """Only a capacity refusal gets the 429; an upstream failure is the caller's."""
    from app.api import routes

    settings = Settings(
        temp_dir=tmp_path / "tmp",
        output_dir=tmp_path / "out",
        runtime_config_path=tmp_path / "runtime.json",
    )
    settings.temp_dir.mkdir(parents=True)
    monkeypatch.setattr(routes, "get_settings", lambda: settings)

    class _Upload:
        filename = "bad.wav"

        def __init__(self):
            self._data = io.BytesIO(_minimal_wav())

        async def read(self, size=-1):
            return self._data.read(size)

    class _RejectingManager:
        async def create_session(self, file_path, config):
            raise RealtimeASRError("上游拒绝了这次识别", code="provider_rejected")

    with pytest.raises(HTTPException) as excinfo:
        await routes.create_transcribe_stream(
            file=_Upload(), model=None, language=None, stm=_RejectingManager()
        )
    assert excinfo.value.status_code == 422
    assert excinfo.value.headers is None
    assert list(settings.temp_dir.iterdir()) == []


def test_transcribe_stream_session_cap_is_enforced_over_http(tmp_path, monkeypatch):
    """The cap is real over HTTP: the third concurrent upload is refused."""
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.json"))
    monkeypatch.setenv("ASR_PROVIDER", "openai_compat")
    monkeypatch.setenv("ASR_BASE_URL", "https://example.test/v1")
    monkeypatch.setenv("ASR_API_KEY", "test-key")
    monkeypatch.setenv("STREAM_MAX_SESSIONS", "1")
    monkeypatch.setenv("SPLIT_CHUNK_SECONDS", "600")

    from app.config import get_settings
    from app.services import stream_transcribe_manager as stream_module

    gate = asyncio.Event()

    class _BlockingProvider:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def transcribe(self, _path, *, prompt=None):
            await gate.wait()
            return ASRResult(text="占位")

    monkeypatch.setattr(stream_module, "create_provider", lambda _settings: _BlockingProvider())
    get_settings.cache_clear()
    from fastapi.testclient import TestClient

    with TestClient(create_app()) as c:
        first = c.post(
            "/asr/transcribe-stream",
            files={"file": ("first.wav", io.BytesIO(_minimal_wav()), "audio/wav")},
        )
        assert first.status_code == 200, first.text
        second = c.post(
            "/asr/transcribe-stream",
            files={"file": ("second.wav", io.BytesIO(_minimal_wav()), "audio/wav")},
        )
        assert second.status_code == 429, second.text
        detail = second.json()["detail"]
        assert detail["code"] == "session_limit"
        assert detail["details"] == {"live": 1, "limit": 1}
        assert int(second.headers["retry-after"]) >= 1
        gate.set()


def test_a_long_upload_is_sliced_into_bounded_provider_calls(tmp_path, monkeypatch):
    """One file, one call was unbounded: a 2 GiB upload normalizes to ~19 h of PCM.

    The batch count inherits `duration / split_chunk_seconds`, which is what
    bounds memory, request body size and upstream fan-out at the same time.
    """
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.json"))
    monkeypatch.setenv("ASR_PROVIDER", "openai_compat")
    monkeypatch.setenv("ASR_BASE_URL", "https://example.test/v1")
    monkeypatch.setenv("ASR_API_KEY", "test-key")
    monkeypatch.setenv("SPLIT_STRATEGY", "fixed")
    monkeypatch.setenv("SPLIT_CHUNK_SECONDS", "2")
    monkeypatch.setenv("SPLIT_OVERLAP_SECONDS", "0")
    monkeypatch.setenv("STREAM_MAX_SESSIONS", "4")

    from app.config import get_settings
    from app.services import stream_transcribe_manager as stream_module

    seen: list[Path] = []

    class _BatchProvider:
        def __init__(self):
            self.calls = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def transcribe(self, path, *, prompt=None):
            self.calls += 1
            seen.append(path)
            return ASRResult(text=f"批次{self.calls}")

    fake = _BatchProvider()
    monkeypatch.setattr(stream_module, "create_provider", lambda _settings: fake)
    get_settings.cache_clear()
    from fastapi.testclient import TestClient

    with TestClient(create_app()) as c:
        r = c.post(
            "/asr/transcribe-stream",
            files={
                "file": ("six.wav", io.BytesIO(_minimal_wav(6.0)), "audio/wav"),
            },
        )
        assert r.status_code == 200, r.text
        sid = r.json()["session_id"]
        with c.stream("GET", f"/asr/transcribe-stream/{sid}/events") as resp:
            events = [line for line in resp.iter_lines() if line.startswith("data:")]

    assert fake.calls == 3  # 6 s at a 2 s ceiling
    # Each call got a slice, and the worker's own normalized file was not sent whole.
    assert len(set(seen)) == 3
    final = [line for line in events if '"final"' in line]
    assert final, events
    import json

    text = json.loads(final[-1][len("data:"):].strip())["text"]
    assert "批次1" in text and "批次3" in text
