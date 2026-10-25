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


@pytest.fixture
def limited_client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "rc.json"))
    monkeypatch.setenv("REALTIME_ASR_PROVIDER", "realtime_mock")
    monkeypatch.setenv("REALTIME_MAX_SESSIONS", "1")
    monkeypatch.setenv("REALTIME_MAX_SESSION_BYTES", "3")
    monkeypatch.setenv("ACCESS_TOKENS", "")
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    with TestClient(create_app()) as c:
        yield c


def _apply_utf16_splice(previous: str, delta: dict) -> str:
    encoded = previous.encode("utf-16-le", errors="surrogatepass")
    start = delta["start"] * 2
    end = start + delta["remove"] * 2
    replacement = delta["text"].encode("utf-16-le", errors="surrogatepass")
    return (encoded[:start] + replacement + encoded[end:]).decode(
        "utf-16-le", errors="surrogatepass"
    )


def test_create_session_returns_urls(client):
    r = client.post("/asr/realtime/session", json={"language": "zh"})
    assert r.status_code == 200, r.text
    data = r.json()
    sid = data["session_id"]
    assert sid
    assert data["events_url"] == f"/asr/realtime/{sid}/events"
    assert data["audio_url"] == f"/asr/realtime/{sid}/audio"
    assert data["end_url"] == f"/asr/realtime/{sid}/end"


def test_session_limit_returns_429(limited_client):
    first = limited_client.post("/asr/realtime/session", json={})
    assert first.status_code == 200
    second = limited_client.post("/asr/realtime/session", json={})
    assert second.status_code == 429
    assert second.json()["detail"]["code"] == "session_limit"


def test_session_resource_limit_returns_413(limited_client):
    sid = limited_client.post("/asr/realtime/session", json={}).json()["session_id"]
    assert limited_client.post(
        f"/asr/realtime/{sid}/audio",
        json={"seq": 1, "audio": "AAAA"},
    ).status_code == 200
    response = limited_client.post(
        f"/asr/realtime/{sid}/audio",
        json={"seq": 2, "audio": "AAAA"},
    )
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "resource_limit"


def test_push_audio_ok(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    r = client.post(
        f"/asr/realtime/{sid}/audio",
        json={"seq": 1, "audio": "AAAAAAAAAAA="},
    )
    body = r.json()
    assert r.status_code == 200
    assert body["ok"] is True
    assert body["seq"] == 1
    # byte/chunk counters ride along so the client skips a per-chunk status GET
    assert body["chunks_received"] == 1
    assert body["bytes_received"] == 8  # "AAAAAAAAAAA=" decodes to 8 bytes


def test_push_invalid_base64_returns_400(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    r = client.post(
        f"/asr/realtime/{sid}/audio",
        json={"seq": 1, "audio": "!!!bad!!!"},
    )
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["code"] == "audio_invalid"
    assert "base64" in detail["message"]


def test_push_empty_chunk_without_final_returns_400(client):
    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    r = client.post(
        f"/asr/realtime/{sid}/audio",
        json={"seq": 0, "audio": "", "is_final": False},
    )
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_request"
    assert detail["retryable"] is False


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


def test_realtime_events_stream_carries_delta(client):
    import json

    sid = client.post("/asr/realtime/session", json={}).json()["session_id"]
    for i in range(6):
        client.post(
            f"/asr/realtime/{sid}/audio",
            json={"seq": i, "audio": "AAAAAAAAAAA="},
        )
    client.post(f"/asr/realtime/{sid}/end")

    with client.stream("GET", f"/asr/realtime/{sid}/events") as resp:
        assert resp.status_code == 200
        payloads = []
        for line in resp.iter_lines():
            if line.startswith("data:"):
                payloads.append(json.loads(line[len("data:"):].strip()))

    text_events = [p for p in payloads if p["type"] == "text"]
    assert text_events, "expected at least one text event from realtime_mock"
    rebuilt = ""
    for evt in text_events:
        assert evt["text"] == "", "realtime stream must emit an empty text field"
        assert isinstance(evt["delta"], dict), "realtime text delta must be a splice edit op"
        assert set(evt["delta"].keys()) == {"start", "remove", "text"}
        d = evt["delta"]
        rebuilt = _apply_utf16_splice(rebuilt, d)
    assert rebuilt, "reconstructed transcript must be non-empty"

    terminal = [p for p in payloads if p["type"] in {"done", "error"}]
    assert terminal
    for evt in terminal:
        assert evt["delta"] is None


def test_session_limit_payload_carries_the_counters(limited_client):
    """The 429 has to say *which* cap and *how full*, not just "limit reached".

    "You are the fifth recorder" and "this deployment's cap is one" need
    different answers from the user, and the frontend cannot tell them apart
    from a sentence.
    """
    assert limited_client.post("/asr/realtime/session", json={}).status_code == 200
    second = limited_client.post("/asr/realtime/session", json={})
    assert second.status_code == 429
    detail = second.json()["detail"]
    assert detail["code"] == "session_limit"
    assert detail["retryable"] is True
    assert detail["details"] == {"live": 1, "limit": 1}


def test_session_limit_sends_retry_after(limited_client):
    """Without a hint the client has to guess how long a slot takes to free."""
    assert limited_client.post("/asr/realtime/session", json={}).status_code == 200
    second = limited_client.post("/asr/realtime/session", json={})
    assert int(second.headers["retry-after"]) >= 1


def test_resource_limit_refusal_is_not_a_capacity_wait(tmp_path, monkeypatch):
    """A session that ran out of its own byte budget is not "wait for a slot"."""
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "rc.json"))
    monkeypatch.setenv("REALTIME_ASR_PROVIDER", "realtime_mock")
    monkeypatch.setenv("REALTIME_MAX_SESSION_BYTES", "1")
    monkeypatch.setenv("ACCESS_TOKENS", "")
    from app.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app
    from fastapi.testclient import TestClient

    with TestClient(create_app()) as c:
        sid = c.post("/asr/realtime/session", json={}).json()["session_id"]
        import base64

        r = c.post(
            f"/asr/realtime/{sid}/audio",
            json={"seq": 1, "audio": base64.b64encode(b"\x00\x00" * 8).decode()},
        )
        assert r.status_code == 413, r.text
        detail = r.json()["detail"]
        assert detail["code"] == "resource_limit"
        # No Retry-After: retrying cannot shrink a file that is already too big,
        # so a wait hint here would invite the client to hammer a dead end.
        assert "retry-after" not in r.headers
        assert detail["retryable"] is False
