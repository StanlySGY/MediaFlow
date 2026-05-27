from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1024")  # 1 KiB ceiling for tests
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    app = create_app()
    return TestClient(app)


def test_unsupported_extension_rejected(client: TestClient):
    r = client.post(
        "/asr/task",
        files={"file": ("nope.exe", io.BytesIO(b"x"), "application/octet-stream")},
    )
    assert r.status_code == 400


def test_upload_rejected_when_over_limit(client: TestClient):
    payload = b"a" * 2048  # 2 KiB > 1 KiB limit
    r = client.post(
        "/asr/task",
        files={"file": ("big.wav", io.BytesIO(payload), "audio/wav")},
    )
    assert r.status_code == 413


def test_missing_task_returns_404(client: TestClient):
    r = client.get("/asr/task/doesnotexist")
    assert r.status_code == 404


def test_health(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_ui_served_at_root(client: TestClient):
    r = client.get("/")
    assert r.status_code == 200
    assert "AudioFlow-ASR" in r.text
