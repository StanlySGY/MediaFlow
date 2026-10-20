from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError


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
    monkeypatch.setenv("REALTIME_ASR_PROVIDER", "realtime_mock")
    monkeypatch.setenv("REALTIME_ASR_BASE_URL", "")
    monkeypatch.setenv("REALTIME_ASR_API_KEY", "")
    monkeypatch.setenv("REALTIME_ASR_MODEL", "")
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


async def test_runtime_config_restores_valid_backup_after_primary_corruption(client):
    c, rc_path = client
    seeded = (await c.get("/asr/profiles")).json()
    await c.post("/asr/config", json={"asr_model": "backup-model"})
    await c.post("/asr/config", json={"asr_model": "current-model"})

    backup_path = rc_path.with_name(rc_path.name + ".bak")
    backup_bytes = backup_path.read_bytes()
    assert json.loads(backup_bytes)["asr_model"] == "backup-model"
    rc_path.write_text("{broken", encoding="utf-8")

    profiles = await c.get("/asr/profiles")
    assert profiles.status_code == 200
    assert profiles.json()["file"] == seeded["file"]
    assert json.loads(rc_path.read_bytes()) == json.loads(backup_bytes)
    assert backup_path.read_bytes() == backup_bytes

    from app.config import get_settings
    get_settings.cache_clear()
    config = await c.get("/asr/config")
    assert config.status_code == 200
    assert config.json()["model"] == "backup-model"


def test_runtime_config_restores_backup_after_semantically_invalid_primary(tmp_path):
    import app.config as config

    path = tmp_path / "runtime.json"
    backup = path.with_name(path.name + ".bak")
    backup_bytes = b'{"asr_model":"backup-model","split_strategy":"fixed"}'
    path.write_text(
        '{"asr_model":"primary-model","asr_concurrency":"invalid",'
        '"split_strategy":"invalid"}',
        encoding="utf-8",
    )
    backup.write_bytes(backup_bytes)
    settings = config.Settings(_env_file=None, runtime_config_path=path)

    assert config._load_runtime_overrides(path, settings) == {
        "asr_model": "backup-model",
        "split_strategy": "fixed",
    }
    assert path.read_bytes() == backup_bytes


def test_runtime_config_ignores_invalid_fields_without_valid_backup(tmp_path):
    import app.config as config

    path = tmp_path / "runtime.json"
    primary_bytes = (
        b'{"asr_model":"primary-model","asr_concurrency":"invalid",'
        b'"split_strategy":"invalid"}'
    )
    path.write_bytes(primary_bytes)
    settings = config.Settings(_env_file=None, runtime_config_path=path)

    assert config._load_runtime_overrides(path, settings) == {
        "asr_model": "primary-model",
    }
    assert path.read_bytes() == primary_bytes


def test_runtime_config_ignores_invalid_split_combination_without_dropping_other_fields(tmp_path):
    import app.config as config

    path = tmp_path / "runtime.json"
    path.write_text(
        json.dumps({
            "asr_model": "primary-model",
            "split_strategy": "overlap",
            "split_chunk_seconds": 10,
            "split_overlap_seconds": 10,
        }),
        encoding="utf-8",
    )
    settings = config.Settings(_env_file=None, runtime_config_path=path)

    overrides = config._load_runtime_overrides(path, settings)
    assert overrides["asr_model"] == "primary-model"
    assert "split_strategy" not in overrides
    assert "split_chunk_seconds" not in overrides
    assert "split_overlap_seconds" not in overrides


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("split_chunk_seconds", 0.01),
        ("split_chunk_seconds", 601),
        ("asr_max_retries", -1),
        ("asr_max_retries", 11),
        ("asr_retry_backoff", 0.5),
        ("asr_retry_backoff", 10.1),
    ],
)
def test_resource_sensitive_settings_reject_pathological_values(field, value):
    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings.model_validate({field: value})


def test_failed_atomic_config_replace_keeps_primary_and_backup(tmp_path, monkeypatch):
    import app.config as config

    path = tmp_path / "runtime.json"
    original = b'{"asr_model":"old"}'
    path.write_bytes(original)
    real_replace = config.os.replace

    def fail_primary(source, destination):
        if Path(destination) == path:
            raise OSError("simulated atomic replace failure")
        return real_replace(source, destination)

    monkeypatch.setattr(config.os, "replace", fail_primary)
    with pytest.raises(OSError, match="simulated"):
        config._write_store(path, {"asr_model": "new"})

    assert path.read_bytes() == original
    assert path.with_name(path.name + ".bak").read_bytes() == original
    assert list(tmp_path.glob(f".{path.name}.*")) == []


def test_failed_first_profile_save_does_not_change_live_settings(tmp_path, monkeypatch):
    import app.config as config

    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.json"))
    monkeypatch.setenv("ASR_BASE_URL", "https://before.test/v1")
    config.get_settings.cache_clear()
    settings = config.get_settings()

    def fail_write(*args, **kwargs):
        raise OSError("simulated profile save failure")

    monkeypatch.setattr(config, "_write_store", fail_write)
    with pytest.raises(OSError, match="simulated profile save failure"):
        config.save_profile(
            None,
            {"name": "未写入", "asr_base_url": "https://after.test/v1"},
        )

    assert settings.asr_base_url == "https://before.test/v1"


def test_failed_profile_activation_does_not_change_live_settings(tmp_path, monkeypatch):
    import app.config as config

    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.json"))
    monkeypatch.setenv("ASR_BASE_URL", "https://before.test/v1")
    config.get_settings.cache_clear()
    settings = config.get_settings()
    profile = config._profiles().profile_from_settings(
        settings, name="待激活", profile_id="profile-1"
    )
    profile["asr_base_url"] = "https://after.test/v1"
    config._write_store(
        settings.runtime_config_path,
        {"profiles": [profile], "active_profile": {"file": "other", "realtime": None}},
    )

    def fail_write(*args, **kwargs):
        raise OSError("simulated profile activation failure")

    monkeypatch.setattr(config, "_write_store", fail_write)
    with pytest.raises(OSError, match="simulated profile activation failure"):
        config.activate_profile("profile-1", "file")

    assert settings.asr_base_url == "https://before.test/v1"


def test_invalid_store_is_preserved_without_overwriting_invalid_backup(tmp_path):
    from app.config import _read_store, _write_store

    path = tmp_path / "runtime.json"
    backup = path.with_name(path.name + ".bak")
    path.write_text("{broken", encoding="utf-8")
    backup.write_text("[]", encoding="utf-8")

    assert _read_store(path) == {}
    _write_store(path, {"asr_model": "fresh"})

    preserved = list(tmp_path.glob(f"{path.name}.corrupt-*"))
    assert len(preserved) == 1
    assert preserved[0].read_text("utf-8") == "{broken"
    assert backup.read_text("utf-8") == "[]"
    assert json.loads(path.read_text("utf-8"))["asr_model"] == "fresh"


def test_missing_store_does_not_restore_or_keep_an_orphaned_backup(tmp_path):
    from app.config import _read_store, _write_store

    path = tmp_path / "runtime.json"
    backup = path.with_name(path.name + ".bak")
    backup.write_text('{"asr_model":"stale"}', encoding="utf-8")

    assert _read_store(path) == {}
    assert not path.exists()

    _write_store(path, {"asr_model": "fresh"})
    assert json.loads(path.read_text("utf-8"))["asr_model"] == "fresh"
    assert not backup.exists()


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


async def test_post_config_applies_normalized_numeric_values(client):
    c, _ = client
    r = await c.post("/asr/config", json={"asr_concurrency": "2"})
    assert r.status_code == 200
    assert r.json()["concurrency"] == 2


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
    await c.post("/asr/config", json={"asr_model": "newer-model"})
    assert rc_path.is_file()
    assert rc_path.with_name(rc_path.name + ".bak").is_file()

    r = await c.post("/asr/config/reset")
    assert r.status_code == 200
    assert r.json()["model"] == "qwen3-asr-flash"  # back to .env default
    assert json.loads(rc_path.read_text("utf-8")) == {}
    assert not rc_path.with_name(rc_path.name + ".bak").exists()


async def test_reset_keeps_live_settings_if_atomic_save_fails(client, monkeypatch):
    c, rc_path = client
    await c.post("/asr/config", json={"asr_model": "alt-model"})
    await c.post("/asr/config", json={"asr_model": "newer-model"})

    import app.config as config
    from app.config import get_settings, reset_runtime_overrides

    settings = get_settings()
    real_replace = config.os.replace

    def fail_primary(source, destination):
        if Path(destination) == rc_path:
            raise OSError("simulated reset replace failure")
        return real_replace(source, destination)

    monkeypatch.setattr(config.os, "replace", fail_primary)
    with pytest.raises(OSError, match="simulated reset"):
        reset_runtime_overrides()

    assert settings.asr_model == "newer-model"
    assert json.loads(rc_path.read_text("utf-8"))["asr_model"] == "newer-model"


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
    assert seeded["realtime_api_key_set"] is False
    assert seeded["realtime_asr_provider"] == "realtime_mock"
    assert "asr_api_key" not in seeded
    assert "realtime_asr_api_key" not in seeded
    # the id is stable across reads, and it is the file pipeline's profile
    again = (await c.get("/asr/profiles")).json()
    assert again["profiles"][0]["id"] == seeded["id"]
    assert data["file"] == seeded["id"]
    assert data["realtime"] is None
    assert rc_path.is_file()


async def test_profile_create_update_keeps_blank_secret(client):
    c, rc_path = client
    r = await c.post("/asr/profiles", json=_profile_body(
        "内网A",
        asr_api_key="sk-keep",
        realtime_asr_provider="realtime_ws",
        realtime_asr_base_url="ws://rt.example/v1/stream",
        realtime_asr_api_key="rt-sk-keep",
        realtime_asr_model="rt-model",
    ))
    assert r.status_code == 200, r.text
    created = r.json()["profile"]
    assert created["api_key_set"] is True
    assert created["realtime_api_key_set"] is True
    assert "sk-keep" not in r.text
    assert "rt-sk-keep" not in r.text

    r = await c.put(f"/asr/profiles/{created['id']}", json={"name": "内网A改名"})
    assert r.status_code == 200, r.text
    assert r.json()["profile"]["name"] == "内网A改名"
    assert r.json()["profile"]["api_key_set"] is True
    assert r.json()["profile"]["realtime_api_key_set"] is True
    assert "sk-keep" not in r.text
    assert "rt-sk-keep" not in r.text
    stored = json.loads(rc_path.read_text("utf-8"))
    saved = next(p for p in stored["profiles"] if p["id"] == created["id"])
    assert saved["asr_api_key"] == "sk-keep"
    assert saved["realtime_asr_api_key"] == "rt-sk-keep"
    assert saved["asr_provider"] == "openai_compat"
    assert saved["realtime_asr_provider"] == "realtime_ws"

    cleared = await c.put(f"/asr/profiles/{created['id']}", json={
        "name": "内网A改名",
        "asr_api_key": "",
        "realtime_asr_api_key": "",
    })
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["profile"]["api_key_set"] is False
    assert cleared.json()["profile"]["realtime_api_key_set"] is False
    stored = json.loads(rc_path.read_text("utf-8"))
    saved = next(p for p in stored["profiles"] if p["id"] == created["id"])
    assert saved["asr_api_key"] == ""
    assert saved["realtime_asr_api_key"] == ""


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
        json=_profile_body(
            "双端点",
            "https://file.test/v1",
            asr_provider="openai_chat_audio",
            asr_api_key="file-secret",
            asr_model="file-model",
            realtime_asr_provider="realtime_ws",
            realtime_asr_base_url="ws://rt.test/v1/stream",
            realtime_asr_api_key="rt-secret",
            realtime_asr_model="rt-model",
        ),
    )).json()["profile"]["id"]

    r = await c.post(f"/asr/profiles/{made}/activate", json={"target": "realtime"})
    assert r.status_code == 200, r.text
    assert r.json()["realtime"] == made
    cfg = (await c.get("/asr/config")).json()
    assert cfg["realtime_asr_provider"] == "realtime_ws"
    assert cfg["realtime_asr_base_url"] == "ws://rt.test/v1/stream"
    assert cfg["realtime_asr_model"] == "rt-model"
    assert cfg["realtime_api_key_set"] is True
    # the file pipeline keeps its own profile
    assert cfg["provider"] == "openai_compat"
    assert cfg["base_url"] == "https://default.test/v1"
    assert r.json()["file"] == first

    r = await c.post(f"/asr/profiles/{made}/activate", json={"target": "file"})
    assert r.status_code == 200, r.text
    cfg = (await c.get("/asr/config")).json()
    assert cfg["provider"] == "openai_chat_audio"
    assert cfg["base_url"] == "https://file.test/v1"
    assert cfg["model"] == "file-model"
    assert cfg["api_key_set"] is True
    # File activation also leaves every realtime setting alone.
    assert cfg["realtime_asr_provider"] == "realtime_ws"
    assert cfg["realtime_asr_base_url"] == "ws://rt.test/v1/stream"
    assert cfg["realtime_asr_model"] == "rt-model"

    bad = await c.post(f"/asr/profiles/{made}/activate", json={"target": "nope"})
    assert bad.status_code == 400


async def test_legacy_profiles_backfill_only_missing_realtime_fields(client):
    c, rc_path = client
    await c.post("/asr/config", json={
        "realtime_asr_provider": "realtime_ws",
        "realtime_asr_base_url": "ws://active-rt.test/v1/stream",
        "realtime_asr_api_key": "active-rt-secret",
        "realtime_asr_model": "active-rt-model",
    })
    store = json.loads(rc_path.read_text("utf-8"))
    store["profiles"] = [
        {
            "id": "legacy-active",
            "name": "旧活动配置",
            "asr_provider": "openai_chat_audio",
            "asr_base_url": "https://legacy-file.test/v1",
            "asr_api_key": "legacy-file-secret",
            "asr_model": "legacy-file-model",
            "asr_language": "zh",
            "asr_hotwords": "",
            "asr_prompt_hints": "",
            "asr_timestamps": True,
            "asr_timeout": 120,
        },
        {
            "id": "legacy-inactive",
            "name": "旧闲置配置",
            "asr_provider": "openai_compat",
            "asr_base_url": "https://inactive-file.test/v1",
            "asr_api_key": "",
            "asr_model": "inactive-file-model",
            "asr_language": "zh",
            "asr_hotwords": "",
            "asr_prompt_hints": "",
            "asr_timestamps": True,
            "asr_timeout": 120,
        },
        {
            "id": "partially-migrated",
            "name": "已有实时字段",
            "asr_provider": "openai_compat",
            "asr_base_url": "https://partial-file.test/v1",
            "asr_api_key": "",
            "asr_model": "partial-file-model",
            "asr_language": "zh",
            "asr_hotwords": "",
            "asr_prompt_hints": "",
            "asr_timestamps": True,
            "asr_timeout": 120,
            "realtime_asr_provider": "realtime_http",
            "realtime_asr_base_url": "https://kept-rt.test/v1",
            "realtime_asr_api_key": "kept-rt-secret",
        },
    ]
    store["active_profile"] = {"file": "legacy-active", "realtime": "legacy-active"}
    rc_path.write_text(json.dumps(store), encoding="utf-8")

    response = await c.get("/asr/profiles")
    assert response.status_code == 200
    data = response.json()
    active = next(p for p in data["profiles"] if p["id"] == "legacy-active")
    inactive = next(p for p in data["profiles"] if p["id"] == "legacy-inactive")
    partial = next(p for p in data["profiles"] if p["id"] == "partially-migrated")
    assert active["realtime_asr_provider"] == "realtime_ws"
    assert active["realtime_asr_base_url"] == "ws://active-rt.test/v1/stream"
    assert active["realtime_asr_model"] == "active-rt-model"
    assert active["api_key_set"] is True
    assert active["realtime_api_key_set"] is True
    assert inactive["realtime_asr_provider"] == "realtime_mock"
    assert inactive["realtime_asr_base_url"] == ""
    assert inactive["realtime_asr_model"] == ""
    assert inactive["realtime_api_key_set"] is False
    assert partial["realtime_asr_provider"] == "realtime_http"
    assert partial["realtime_asr_base_url"] == "https://kept-rt.test/v1"
    assert partial["realtime_asr_model"] == ""
    assert partial["realtime_api_key_set"] is True
    assert "legacy-file-secret" not in response.text
    assert "active-rt-secret" not in response.text
    assert "kept-rt-secret" not in response.text
    assert "asr_api_key" not in active
    assert "realtime_asr_api_key" not in active

    cfg = (await c.get("/asr/config")).json()
    assert cfg["realtime_asr_provider"] == "realtime_ws"
    assert cfg["realtime_asr_base_url"] == "ws://active-rt.test/v1/stream"
    assert cfg["realtime_asr_model"] == "active-rt-model"

    updated = await c.put("/asr/profiles/legacy-active", json={"name": "旧活动配置改名"})
    assert updated.status_code == 200, updated.text
    assert updated.json()["profile"]["realtime_asr_provider"] == "realtime_ws"
    assert updated.json()["profile"]["realtime_api_key_set"] is True
    assert "active-rt-secret" not in updated.text
    stored = json.loads(rc_path.read_text("utf-8"))
    saved_active = next(p for p in stored["profiles"] if p["id"] == "legacy-active")
    saved_inactive = next(p for p in stored["profiles"] if p["id"] == "legacy-inactive")
    saved_partial = next(p for p in stored["profiles"] if p["id"] == "partially-migrated")
    assert saved_active["realtime_asr_api_key"] == "active-rt-secret"
    assert saved_active["asr_api_key"] == "legacy-file-secret"
    assert saved_inactive["realtime_asr_provider"] == "realtime_mock"
    assert saved_partial["realtime_asr_api_key"] == "kept-rt-secret"
    assert saved_partial["realtime_asr_provider"] == "realtime_http"


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
    assert not rc_path.with_name(rc_path.name + ".bak").exists()
    after = (await c.get("/asr/profiles")).json()
    assert set(json.loads(rc_path.read_text("utf-8"))) == {"profiles", "active_profile"}
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


async def test_config_reports_the_upload_gate_the_client_hits(client):
    """The browser filters the picker and refuses an oversize pick before any
    byte goes on the wire, so it has to read the real gate from the server."""
    from app.api.routes import ALLOWED_EXTS

    c, _ = client
    g = (await c.get("/asr/config")).json()
    assert g["allowed_exts"] == sorted(ALLOWED_EXTS)
    assert ".mp4" in g["allowed_exts"]
    assert ".zip" not in g["allowed_exts"]
    assert isinstance(g["max_upload_bytes"], int) and g["max_upload_bytes"] > 0

    # A save returns the same payload shape, so the UI can re-read the gate
    # after changing the limit.
    r = await c.post("/asr/config", json={"max_upload_bytes": 64 * 1024 * 1024})
    assert r.status_code == 200, r.text
    assert r.json()["max_upload_bytes"] == 64 * 1024 * 1024
    assert r.json()["allowed_exts"] == sorted(ALLOWED_EXTS)


async def test_upload_rejects_extension_outside_reported_gate(client, tmp_path):
    c, _ = client
    exts = (await c.get("/asr/config")).json()["allowed_exts"]
    rejected = ".zip"
    assert rejected not in exts

    r = await c.post(
        "/asr/file",
        files={"file": ("evidence.zip", b"not audio", "application/zip")},
    )
    assert r.status_code == 400, r.text
    assert rejected in r.json()["detail"]
