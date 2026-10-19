from __future__ import annotations

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
    client = TestClient(create_app())
    try:
        yield client
    finally:
        client.close()
        get_settings.cache_clear()


@pytest.fixture
def open_client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("ACCESS_TOKENS", "")
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    client = TestClient(create_app())
    try:
        yield client
    finally:
        client.close()
        get_settings.cache_clear()


def test_auth_required_blocks_unauthenticated(secured_client):
    r = secured_client.get("/asr/task/whatever")
    assert r.status_code == 401


def test_auth_accepts_valid_bearer(secured_client):
    r = secured_client.get(
        "/asr/config",
        headers={"Authorization": "Bearer secret-a"},
    )
    assert r.status_code == 200
    cookie = r.headers.get("set-cookie", "")
    assert "mediaflow_sse_auth=secret-a" in cookie
    assert "HttpOnly" in cookie
    assert "SameSite=strict" in cookie


def test_auth_rejects_wrong_token(secured_client):
    r = secured_client.get("/asr/task/whatever", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_auth_accepts_token_query(secured_client):
    r = secured_client.get("/asr/realtime/missing/events?token=secret-b")
    assert r.status_code == 404


def test_auth_rejects_query_token_on_ordinary_routes(secured_client):
    r = secured_client.get("/asr/task/whatever?token=secret-b")
    assert r.status_code == 401


def test_sse_cookie_auth_is_limited_to_sse_routes(secured_client):
    secured_client.cookies.set("mediaflow_sse_auth", "secret-a")
    sse = secured_client.get("/asr/realtime/missing/events")
    assert sse.status_code == 404  # cookie authenticated the SSE request

    ordinary = secured_client.post("/asr/realtime/session", json={})
    assert ordinary.status_code == 401  # cookie cannot authenticate state changes


def test_logout_clears_sse_cookie(secured_client):
    secured_client.get("/asr/config", headers={"Authorization": "Bearer secret-a"})
    assert secured_client.cookies.get("mediaflow_sse_auth") == "secret-a"
    response = secured_client.post("/auth/logout")
    assert response.status_code == 204
    set_cookie = response.headers.get("set-cookie", "")
    assert 'mediaflow_sse_auth=""' in set_cookie
    assert "Max-Age=0" in set_cookie
    assert "Path=/" in set_cookie
    assert secured_client.cookies.get("mediaflow_sse_auth") is None


def test_auth_info_reports_status(secured_client):
    r = secured_client.get("/auth/info")
    assert r.status_code == 200 and r.json() == {"auth_required": True}


def test_health_and_ui_dont_require_auth(secured_client):
    assert secured_client.get("/health").status_code == 200
    assert secured_client.get("/").status_code == 200


def test_no_tokens_disables_auth(open_client):
    assert open_client.get("/asr/task/whatever").status_code == 404
    assert open_client.get("/auth/info").json() == {"auth_required": False}


def test_metrics_requires_token_when_configured(secured_client):
    assert secured_client.get("/metrics").status_code == 401
    response = secured_client.get(
        "/metrics", headers={"Authorization": "Bearer secret-a"}
    )
    assert response.status_code == 200
    assert "requests_total" in response.text


def test_default_server_bind_is_loopback(monkeypatch):
    monkeypatch.delenv("HOST", raising=False)
    from app.config import Settings

    assert Settings(_env_file=None).host == "127.0.0.1"
