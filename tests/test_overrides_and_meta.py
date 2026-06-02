from __future__ import annotations

import wave
from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient


def _make_silent_wav(path: Path, seconds: float = 0.5) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * int(16000 * seconds))


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("ASR_BASE_URL", "https://example.test/v1")
    monkeypatch.setenv("ASR_API_KEY", "secret")
    monkeypatch.setenv("ASR_MODEL", "qwen3-asr-flash")
    monkeypatch.setenv("ASR_HOTWORDS", "千问,ASR")
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    return TestClient(create_app())


def test_config_exposes_settings_without_secrets(client):
    r = client.get("/asr/config")
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
def test_ping_ok(client):
    respx.post("https://example.test/v1/audio/transcriptions").mock(
        return_value=httpx.Response(200, json={"text": "silence", "words": [{"word": "_", "start": 0, "end": 1}]}),
    )
    r = client.post("/asr/ping")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["model"] == "qwen3-asr-flash"
    assert data["got_words"] is True


@respx.mock
def test_ping_reports_upstream_error(client):
    respx.post("https://example.test/v1/audio/transcriptions").mock(
        return_value=httpx.Response(401, text="bad key"),
    )
    r = client.post("/asr/ping")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert "401" in data["error"] or "bad key" in data["error"]


def test_task_overrides_propagate(client, tmp_path: Path, monkeypatch):
    captured = {}

    async def fake_submit(self, source_path, original_name, *, overrides=None):
        captured["overrides"] = overrides
        # cleanup the uploaded file like the real path would
        source_path.unlink(missing_ok=True)
        return "fake-task-id"

    from app.services.stream_manager import TaskManager
    monkeypatch.setattr(TaskManager, "submit", fake_submit)

    wav = tmp_path / "x.wav"
    _make_silent_wav(wav)

    r = client.post(
        "/asr/task",
        files={"file": ("x.wav", wav.read_bytes(), "audio/wav")},
        data={
            "model": "alt-model",
            "language": "en",
            "split_strategy": "fixed",
            "chunk_seconds": "45",
            "overlap_seconds": "3",
            "hotwords": "foo,bar",
            "timestamps": "false",
        },
    )
    assert r.status_code == 200
    ov = captured["overrides"]
    assert ov["asr_model"] == "alt-model"
    assert ov["asr_language"] == "en"
    assert ov["split_strategy"] == "fixed"
    assert ov["split_chunk_seconds"] == 45.0
    assert ov["split_overlap_seconds"] == 3.0
    assert ov["asr_hotwords"] == "foo,bar"
    assert ov["asr_timestamps"] is False


def test_task_without_overrides_passes_none(client, tmp_path: Path, monkeypatch):
    captured = {}

    async def fake_submit(self, source_path, original_name, *, overrides=None):
        captured["overrides"] = overrides
        source_path.unlink(missing_ok=True)
        return "id"

    from app.services.stream_manager import TaskManager
    monkeypatch.setattr(TaskManager, "submit", fake_submit)

    wav = tmp_path / "y.wav"
    _make_silent_wav(wav)
    r = client.post("/asr/task", files={"file": ("y.wav", wav.read_bytes(), "audio/wav")})
    assert r.status_code == 200
    assert captured["overrides"] is None


def test_invalid_split_strategy_rejected(client, tmp_path: Path):
    wav = tmp_path / "z.wav"
    _make_silent_wav(wav)
    r = client.post(
        "/asr/task",
        files={"file": ("z.wav", wav.read_bytes(), "audio/wav")},
        data={"split_strategy": "garbage"},
    )
    assert r.status_code == 400
