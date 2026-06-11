from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest


@pytest.fixture
async def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "rc.json"))
    monkeypatch.setenv("ASR_BASE_URL", "https://default.test/v1")
    monkeypatch.setenv("ASR_API_KEY", "")
    monkeypatch.setenv("ASR_MODEL", "qwen3-asr-flash")
    monkeypatch.setenv("ASR_HOTWORDS", "")
    monkeypatch.setenv("ACCESS_TOKENS", "")
    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as c:
        yield c, tmp_path / "rc.json"


async def test_post_config_persists_and_applies(client):
    c, rc_path = client
    r = await c.post("/asr/config", json={
        "asr_model": "alt-model",
        "asr_hotwords": "foo,bar",
        "asr_timestamps": False,
    })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["model"] == "alt-model"
    assert data["hotwords"] == "foo,bar"
    assert data["timestamps"] is False

    # persisted
    on_disk = json.loads(rc_path.read_text("utf-8"))
    assert on_disk["asr_model"] == "alt-model"
    assert on_disk["asr_hotwords"] == "foo,bar"
    assert on_disk["asr_timestamps"] is False

    # GET reflects same values
    g = (await c.get("/asr/config")).json()
    assert g["model"] == "alt-model"
    assert g["hotwords"] == "foo,bar"


async def test_post_config_rejects_unknown_field(client):
    c, _ = client
    r = await c.post("/asr/config", json={"asr_secret_url": "x"})
    assert r.status_code == 400
    assert "not writable" in r.json()["detail"]


async def test_post_config_rejects_unwritable_field(client):
    c, _ = client
    # temp_dir is not in WRITABLE_FIELDS
    r = await c.post("/asr/config", json={"temp_dir": "/etc"})
    assert r.status_code == 400


async def test_post_config_validates_provider(client):
    c, _ = client
    r = await c.post("/asr/config", json={"asr_provider": "definitely-not-real"})
    assert r.status_code == 400
    assert "unknown provider" in r.json()["detail"]


async def test_post_config_validates_realtime_provider(client):
    c, _ = client
    r = await c.post(
        "/asr/config", json={"realtime_asr_provider": "definitely-not-real"}
    )
    assert r.status_code == 400
    assert "unknown realtime provider" in r.json()["detail"]


async def test_post_config_can_set_realtime_provider_and_hides_secret(client):
    c, _ = client
    r = await c.post("/asr/config", json={
        "realtime_asr_provider": "realtime_offline",
        "realtime_asr_base_url": "https://rt.example/v1",
        "realtime_asr_api_key": "rt-secret",
        "realtime_asr_model": "rt-model",
    })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["realtime_asr_provider"] == "realtime_offline"
    assert data["realtime_asr_base_url"] == "https://rt.example/v1"
    assert data["realtime_asr_model"] == "rt-model"
    assert data["realtime_api_key_set"] is True
    assert "rt-secret" not in str(data)
    assert "realtime_asr_api_key" not in data


async def test_post_config_validates_split_strategy(client):
    c, _ = client
    r = await c.post("/asr/config", json={"split_strategy": "garbage"})
    assert r.status_code == 400


async def test_post_config_validates_types(client):
    c, _ = client
    # concurrency must be int → string "abc" should fail pydantic coercion
    r = await c.post("/asr/config", json={"asr_concurrency": "abc"})
    assert r.status_code == 400


async def test_post_config_can_set_api_key_then_get_hides_it(client):
    c, _ = client
    r = await c.post("/asr/config", json={"asr_api_key": "sk-secret"})
    assert r.status_code == 200
    data = r.json()
    assert data["api_key_set"] is True
    assert "sk-secret" not in str(data)
    assert "api_key" not in data


async def test_post_config_can_set_access_tokens(client):
    c, _ = client
    r = await c.post("/asr/config", json={"access_tokens": "tok-a,tok-b"})
    assert r.status_code == 200
    data = r.json()
    assert data["access_tokens_count"] == 2
    assert "tok-a" not in str(data)
    # auth now required for /asr/config itself on subsequent calls
    r2 = await c.get("/asr/config")
    assert r2.status_code == 401
    r3 = await c.get("/asr/config", headers={"Authorization": "Bearer tok-b"})
    assert r3.status_code == 200


async def test_reset_clears_overrides_and_restores_env_defaults(client):
    c, rc_path = client
    await c.post("/asr/config", json={"asr_model": "alt-model"})
    assert rc_path.is_file()

    r = await c.post("/asr/config/reset")
    assert r.status_code == 200
    assert r.json()["model"] == "qwen3-asr-flash"  # back to .env default
    assert not rc_path.exists()


async def test_overrides_loaded_on_fresh_startup(tmp_path: Path, monkeypatch):
    rc = tmp_path / "rc.json"
    rc.write_text(json.dumps({
        "asr_model": "from-disk",
        "asr_base_url": "https://restored.test/v1",
        "asr_timestamps": False,
    }), encoding="utf-8")
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(rc))
    monkeypatch.setenv("ASR_MODEL", "should-be-overridden")

    from app.config import get_settings
    get_settings.cache_clear()
    from app.main import create_app
    transport = httpx.ASGITransport(app=create_app())

    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as c:
        g = (await c.get("/asr/config")).json()
    assert g["model"] == "from-disk"
    assert g["base_url"] == "https://restored.test/v1"
    assert g["timestamps"] is False


async def test_empty_body_rejected(client):
    c, _ = client
    r = await c.post("/asr/config", json={})
    assert r.status_code == 400


async def test_writable_fields_advertised(client):
    c, _ = client
    g = (await c.get("/asr/config")).json()
    assert "asr_model" in g["writable_fields"]
    assert "asr_api_key" in g["writable_fields"]
    assert "access_tokens" in g["writable_fields"]
    # operational fields are not writable
    assert "temp_dir" not in g["writable_fields"]
    assert "host" not in g["writable_fields"]
    # sensitive fields advertised so UI can render password-style inputs
    assert "asr_api_key" in g["sensitive_fields"]
    assert "access_tokens" in g["sensitive_fields"]
