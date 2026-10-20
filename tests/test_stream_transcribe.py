from __future__ import annotations

import asyncio
import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.asr.base import ASRResult
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
