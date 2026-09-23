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

    # a later save keeps the previous copy, so a bad save is recoverable
    r2 = await c.post("/asr/config", json={"asr_model": "newer-model"})
    assert r2.status_code == 200
    backup = rc_path.with_name(rc_path.name + ".bak")
    assert json.loads(backup.read_text("utf-8"))["asr_model"] == "alt-model"
    assert (backup.stat().st_mode & 0o777) == 0o600
    assert json.loads(rc_path.read_text("utf-8"))["asr_model"] == "newer-model"

    # GET reflects same values
    g = (await c.get("/asr/config")).json()
    assert g["model"] == "newer-model"
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


def _profile_body(name: str, url: str = "https://a.test/v1", **extra) -> dict:
    return {"name": name, "asr_base_url": url, **extra}


async def test_profiles_seed_default_from_flat_settings(client):
    c, rc_path = client
    r = await c.get("/asr/profiles")
    assert r.status_code == 200
    data = r.json()
    assert len(data["profiles"]) == 1
    seeded = data["profiles"][0]
    assert seeded["name"] == "默认配置"
    assert seeded["asr_base_url"] == "https://default.test/v1"
    assert seeded["api_key_set"] is False
    assert "asr_api_key" not in seeded
    # the id is stable across reads, and it is the file pipeline's profile
    again = (await c.get("/asr/profiles")).json()
    assert again["profiles"][0]["id"] == seeded["id"]
    assert data["file"] == seeded["id"]
    assert data["realtime"] is None
    assert rc_path.is_file()


async def test_profile_create_update_keeps_blank_secret(client):
    c, rc_path = client
    r = await c.post("/asr/profiles", json=_profile_body("内网A", asr_api_key="sk-keep"))
    assert r.status_code == 200, r.text
    created = r.json()["profile"]
    assert created["api_key_set"] is True
    assert "sk-keep" not in r.text

    r = await c.put(f"/asr/profiles/{created['id']}", json={"name": "内网A改名"})
    assert r.status_code == 200, r.text
    assert r.json()["profile"]["name"] == "内网A改名"
    assert r.json()["profile"]["api_key_set"] is True
    stored = json.loads(rc_path.read_text("utf-8"))
    saved = next(p for p in stored["profiles"] if p["id"] == created["id"])
    assert saved["asr_api_key"] == "sk-keep"


async def test_profile_rejects_duplicate_name_and_empty_url(client):
    c, _ = client
    assert (await c.post("/asr/profiles", json=_profile_body("内网A"))).status_code == 200
    dup = await c.post("/asr/profiles", json=_profile_body("内网A", "https://b.test/v1"))
    assert dup.status_code == 400
    assert "同名" in dup.json()["detail"]
    blank = await c.post("/asr/profiles", json={"name": "没地址", "asr_base_url": "  "})
    assert blank.status_code == 400
    assert "接口地址" in blank.json()["detail"]


async def test_activate_profile_drives_the_pipeline_it_targets(client):
    c, _ = client
    first = (await c.get("/asr/profiles")).json()["profiles"][0]["id"]
    made = (await c.post(
        "/asr/profiles",
        json=_profile_body("实时用", "https://rt.test/v1", asr_model="rt-model",
                           asr_provider="openai_compat"),
    )).json()["profile"]["id"]

    r = await c.post(f"/asr/profiles/{made}/activate", json={"target": "realtime"})
    assert r.status_code == 200, r.text
    assert r.json()["realtime"] == made
    cfg = (await c.get("/asr/config")).json()
    assert cfg["realtime_asr_base_url"] == "https://rt.test/v1"
    assert cfg["realtime_asr_model"] == "rt-model"
    # the file pipeline keeps its own profile
    assert cfg["base_url"] == "https://default.test/v1"
    assert r.json()["file"] == first

    bad = await c.post(f"/asr/profiles/{made}/activate", json={"target": "nope"})
    assert bad.status_code == 400


async def test_cannot_delete_last_or_in_use_profile(client):
    c, _ = client
    only = (await c.get("/asr/profiles")).json()["profiles"][0]["id"]
    r = await c.delete(f"/asr/profiles/{only}")
    assert r.status_code == 400
    assert "至少保留" in r.json()["detail"]

    spare = (await c.post("/asr/profiles", json=_profile_body("备用"))).json()["profile"]["id"]
    in_use = await c.delete(f"/asr/profiles/{only}")
    assert in_use.status_code == 400
    assert "正在使用" in in_use.json()["detail"]
    assert (await c.delete(f"/asr/profiles/{spare}")).status_code == 200


async def test_editing_active_profile_reaches_the_pipeline(client):
    c, _ = client
    active = (await c.get("/asr/profiles")).json()["file"]
    r = await c.put(
        f"/asr/profiles/{active}",
        json={"name": "默认配置", "asr_model": "switched-model"},
    )
    assert r.status_code == 200, r.text
    assert (await c.get("/asr/config")).json()["model"] == "switched-model"


async def test_flat_config_save_and_reset_keep_profiles(client):
    c, rc_path = client
    made = (await c.post("/asr/profiles", json=_profile_body("内网A"))).json()
    ids = {p["id"] for p in made["profiles"]}

    saved = await c.post("/asr/config", json={"asr_concurrency": 2})
    assert saved.status_code == 200
    on_disk = json.loads(rc_path.read_text("utf-8"))
    assert {p["id"] for p in on_disk["profiles"]} == ids

    reset = await c.post("/asr/config/reset")
    assert reset.status_code == 200
    assert reset.json()["concurrency"] == 4  # back to the default
    after = (await c.get("/asr/profiles")).json()
    assert {p["id"] for p in after["profiles"]} == ids


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
