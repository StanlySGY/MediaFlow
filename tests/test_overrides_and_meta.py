from __future__ import annotations

import tempfile
import wave
from pathlib import Path

import httpx
import pytest
import respx
from fastapi import HTTPException, UploadFile


def _make_silent_wav(path: Path, seconds: float = 0.5) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * int(16000 * seconds))


@pytest.fixture
async def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("ASR_BASE_URL", "https://example.test/v1")
    monkeypatch.setenv("ASR_API_KEY", "secret")
    monkeypatch.setenv("ASR_MODEL", "qwen3-asr-flash")
    monkeypatch.setenv("ASR_HOTWORDS", "千问,ASR")
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as c:
        yield c


class _NoThreadAioFile:
    async def __aenter__(self) -> "_NoThreadAioFile":
        return self

    async def __aexit__(self, *exc) -> None:
        pass

    async def write(self, data: bytes) -> int:
        return len(data)


class _CapturingManager:
    def __init__(self, task_id: str = "id") -> None:
        self.task_id = task_id
        self.overrides = None

    async def submit(self, source_path, original_name, *, overrides=None):
        self.overrides = overrides
        source_path.unlink(missing_ok=True)
        return self.task_id


def _upload_file(filename: str, data: bytes) -> UploadFile:
    fp = tempfile.SpooledTemporaryFile(max_size=len(data) + 1)
    fp.write(data)
    fp.seek(0)
    return UploadFile(file=fp, filename=filename)


@pytest.fixture
def no_thread_upload_writer(monkeypatch):
    from app.api import routes

    monkeypatch.setattr(
        routes.aiofiles,
        "open",
        lambda *args, **kwargs: _NoThreadAioFile(),
    )


async def test_config_exposes_settings_without_secrets(client):
    r = await client.get("/asr/config")
    assert r.status_code == 200
    data = r.json()
    assert data["provider"] == "openai_compat"
    assert data["model"] == "qwen3-asr-flash"
    assert data["hotwords"] == "千问,ASR"
    assert data["api_key_set"] is True
    assert data["access_tokens_count"] == 0
    # secret must not be leaked
    assert "api_key" not in data
    assert "secret" not in str(data)
    assert "access_tokens" not in data


@respx.mock
async def test_ping_ok(client):
    respx.post("https://example.test/v1/audio/transcriptions").mock(
        return_value=httpx.Response(
            200,
            json={
                "text": "silence",
                "words": [{"word": "_", "start": 0, "end": 1}],
            },
        ),
    )
    r = await client.post("/asr/ping")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["model"] == "qwen3-asr-flash"
    assert data["got_words"] is True


@respx.mock
async def test_ping_reports_upstream_error(client):
    respx.post("https://example.test/v1/audio/transcriptions").mock(
        return_value=httpx.Response(401, text="bad key"),
    )
    r = await client.post("/asr/ping")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert "401" in data["error"] or "bad key" in data["error"]


async def test_task_overrides_propagate(
    tmp_path: Path, no_thread_upload_writer
):
    from app.api.routes import create_task

    manager = _CapturingManager("fake-task-id")
    wav = tmp_path / "x.wav"
    _make_silent_wav(wav)

    r = await create_task(
        file=_upload_file("x.wav", wav.read_bytes()),
        model="alt-model",
        language="en",
        split_strategy="fixed",
        chunk_seconds=45,
        overlap_seconds=3,
        hotwords="foo,bar",
        prompt_hints=None,
        timestamps=False,
        manager=manager,
    )
    assert r == {"task_id": "fake-task-id"}
    ov = manager.overrides
    assert ov["asr_model"] == "alt-model"
    assert ov["asr_language"] == "en"
    assert ov["split_strategy"] == "fixed"
    assert ov["split_chunk_seconds"] == 45.0
    assert ov["split_overlap_seconds"] == 3.0
    assert ov["asr_hotwords"] == "foo,bar"
    assert ov["asr_timestamps"] is False


async def test_file_alias_upload_returns_streaming_urls(
    tmp_path: Path, no_thread_upload_writer
):
    from app.api.routes import create_file_transcription

    manager = _CapturingManager("file-task-id")
    wav = tmp_path / "file.wav"
    _make_silent_wav(wav)

    r = await create_file_transcription(
        file=_upload_file("file.wav", wav.read_bytes()),
        model="file-model",
        language="zh",
        split_strategy=None,
        chunk_seconds=None,
        overlap_seconds=None,
        hotwords=None,
        prompt_hints=None,
        timestamps=None,
        manager=manager,
    )
    assert r == {
        "task_id": "file-task-id",
        "status_url": "/asr/file/file-task-id",
        "events_url": "/asr/file/file-task-id/events",
        "result_url": "/asr/file/file-task-id/result",
    }
    assert manager.overrides["asr_model"] == "file-model"
    assert manager.overrides["asr_language"] == "zh"


async def test_task_without_overrides_passes_none(
    tmp_path: Path, no_thread_upload_writer
):
    from app.api.routes import create_task

    manager = _CapturingManager()
    wav = tmp_path / "y.wav"
    _make_silent_wav(wav)
    r = await create_task(
        file=_upload_file("y.wav", wav.read_bytes()),
        model=None,
        language=None,
        split_strategy=None,
        chunk_seconds=None,
        overlap_seconds=None,
        hotwords=None,
        prompt_hints=None,
        timestamps=None,
        manager=manager,
    )
    assert r == {"task_id": "id"}
    assert manager.overrides is None


async def test_invalid_split_strategy_rejected(tmp_path: Path, no_thread_upload_writer):
    from app.api.routes import create_task

    wav = tmp_path / "z.wav"
    _make_silent_wav(wav)
    with pytest.raises(HTTPException) as exc_info:
        await create_task(
            file=_upload_file("z.wav", wav.read_bytes()),
            model=None,
            language=None,
            split_strategy="garbage",
            chunk_seconds=None,
            overlap_seconds=None,
            hotwords=None,
            prompt_hints=None,
            timestamps=None,
            manager=_CapturingManager(),
        )
    assert exc_info.value.status_code == 400
    assert "split_strategy" in exc_info.value.detail
