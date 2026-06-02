from __future__ import annotations

import io
import subprocess
import wave
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
    assert "MediaFlow" in r.text


def _wav_bytes(seconds: float = 0.5) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buf.getvalue()


@pytest.fixture
def concat_client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("MAX_UPLOAD_BYTES", str(10 * 1024 * 1024))
    from app.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app

    return TestClient(create_app())


def test_concat_merges_same_format(concat_client: TestClient):
    a, b = _wav_bytes(0.5), _wav_bytes(0.5)
    r = concat_client.post(
        "/media/concat",
        files=[
            ("files", ("a.wav", io.BytesIO(a), "audio/wav")),
            ("files", ("b.wav", io.BytesIO(b), "audio/wav")),
        ],
    )
    assert r.status_code == 200
    with wave.open(io.BytesIO(r.content), "rb") as wf:
        seconds = wf.getnframes() / wf.getframerate()
    assert seconds > 0.8  # two 0.5s clips merged end to end


def test_concat_rejects_single_file(client: TestClient):
    r = client.post(
        "/media/concat",
        files=[("files", ("a.wav", io.BytesIO(b"x"), "audio/wav"))],
    )
    assert r.status_code == 400


def test_concat_rejects_mixed_formats(client: TestClient):
    r = client.post(
        "/media/concat",
        files=[
            ("files", ("a.wav", io.BytesIO(b"x"), "audio/wav")),
            ("files", ("b.mp3", io.BytesIO(b"y"), "audio/mpeg")),
        ],
    )
    assert r.status_code == 400


def test_concat_rejects_unsupported_ext(client: TestClient):
    r = client.post(
        "/media/concat",
        files=[
            ("files", ("a.exe", io.BytesIO(b"x"), "application/octet-stream")),
            ("files", ("b.exe", io.BytesIO(b"y"), "application/octet-stream")),
        ],
    )
    assert r.status_code == 400


def _mp4_bytes(path: Path, seconds: int = 1) -> bytes:
    # Identical encode params so the concat demuxer can stream-copy them.
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size=320x240:rate=30:duration={seconds}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path.read_bytes()


def test_concat_merges_video(concat_client: TestClient, tmp_path: Path):
    a = _mp4_bytes(tmp_path / "a.mp4")
    b = _mp4_bytes(tmp_path / "b.mp4")
    r = concat_client.post(
        "/media/concat",
        files=[
            ("files", ("a.mp4", io.BytesIO(a), "video/mp4")),
            ("files", ("b.mp4", io.BytesIO(b), "video/mp4")),
        ],
    )
    assert r.status_code == 200
    out = tmp_path / "merged.mp4"
    out.write_bytes(r.content)
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(out),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert float(probe.stdout.strip()) > 1.6  # two ~1s clips merged end to end
