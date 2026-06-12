from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "rc.json"))
    monkeypatch.setenv("REALTIME_ASR_PROVIDER", "realtime_mock")
    monkeypatch.setenv("REALTIME_MAX_CHUNK_BYTES", "2048")
    monkeypatch.setenv("ACCESS_TOKENS", "")
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def secured_client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "rc.json"))
    monkeypatch.setenv("REALTIME_ASR_PROVIDER", "realtime_mock")
    monkeypatch.setenv("ACCESS_TOKENS", "tok")
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    with TestClient(create_app()) as c:
        yield c


def test_create_session_returns_urls(client):
    r = client.post("/asr/realtime/session", json={"language": "zh"})
    assert r.status_code == 200, r.text
    data = r.json()
    sid = data["session_id"]
    assert sid
    assert data["events_url"] == f"/asr/realtime/{sid}/events"
    assert data["audio_url"] == f"/asr/realtime/{sid}/audio"
    assert data["end_url"] == f"/asr/realtime/{sid}/end"


def test_push_audio_ok(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    r = client.post(
        f"/asr/realtime/{sid}/audio",
        json={"seq": 1, "audio": "AAAAAAAAAAA="},
    )
    assert r.status_code == 200 and r.json() == {"ok": True, "seq": 1}


def test_push_invalid_base64_returns_400(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    r = client.post(
        f"/asr/realtime/{sid}/audio",
        json={"seq": 1, "audio": "!!!bad!!!"},
    )
    assert r.status_code == 400
    assert "base64" in r.json()["detail"]


def test_push_empty_chunk_without_final_returns_400(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    r = client.post(
        f"/asr/realtime/{sid}/audio",
        json={"seq": 0, "audio": "", "is_final": False},
    )
    assert r.status_code == 400


def test_push_to_missing_session_404(client):
    r = client.post(
        "/asr/realtime/nope/audio",
        json={"seq": 0, "audio": "AAAA"},
    )
    assert r.status_code == 404


def test_end_then_get_status_done(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    client.post(f"/asr/realtime/{sid}/audio", json={"seq": 1, "audio": "AAAA"})
    r = client.post(f"/asr/realtime/{sid}/end")
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_realtime_sse_endpoint_exists(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    r = client.get(f"/asr/realtime/{sid}")
    assert r.status_code == 200
    assert r.json()["events_url"] == f"/asr/realtime/{sid}/events"


def test_delete_session(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    r = client.delete(f"/asr/realtime/{sid}")
    assert r.status_code == 200
    r2 = client.get(f"/asr/realtime/{sid}")
    assert r2.status_code == 404


def test_list_sessions(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    r = client.get("/asr/realtime/sessions")
    assert r.status_code == 200
    data = r.json()
    assert any(s["session_id"] == sid for s in data["sessions"])
    assert "realtime_mock" in data["providers"]


def test_auth_required_for_realtime(secured_client):
    r = secured_client.post("/asr/realtime/session", json={})
    assert r.status_code == 401
    r2 = secured_client.post(
        "/asr/realtime/session", json={},
        headers={"Authorization": "Bearer tok"},
    )
    assert r2.status_code == 200
