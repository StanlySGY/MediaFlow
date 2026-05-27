from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def secured_client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("ACCESS_TOKENS", "secret-a, secret-b")
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1024")
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    return TestClient(create_app())


@pytest.fixture
def open_client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("ACCESS_TOKENS", "")
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    return TestClient(create_app())


def test_auth_required_blocks_unauthenticated(secured_client):
    r = secured_client.get("/asr/task/whatever")
    assert r.status_code == 401


def test_auth_accepts_valid_bearer(secured_client):
    r = secured_client.get("/asr/task/whatever", headers={"Authorization": "Bearer secret-a"})
    assert r.status_code == 404  # passed auth, then missing task


def test_auth_rejects_wrong_token(secured_client):
    r = secured_client.get("/asr/task/whatever", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_auth_accepts_token_query(secured_client):
    r = secured_client.get("/asr/task/whatever?token=secret-b")
    assert r.status_code == 404


def test_auth_info_reports_status(secured_client):
    r = secured_client.get("/auth/info")
    assert r.status_code == 200 and r.json() == {"auth_required": True}


def test_health_and_ui_dont_require_auth(secured_client):
    assert secured_client.get("/health").status_code == 200
    assert secured_client.get("/").status_code == 200


def test_no_tokens_disables_auth(open_client):
    assert open_client.get("/asr/task/whatever").status_code == 404
    assert open_client.get("/auth/info").json() == {"auth_required": False}
