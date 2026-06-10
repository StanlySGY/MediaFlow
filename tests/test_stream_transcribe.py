from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client():
    app = create_app()
    return TestClient(app)


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


def _minimal_wav(duration: float = 0.1, sample_rate: int = 16000) -> bytes:
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * int(sample_rate * duration))
    return buf.getvalue()
