from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from functools import lru_cache
from pathlib import Path

from pydantic import Field, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

def _profiles():
    """Imported lazily: the asr package imports Settings at module load."""
    from app.services.asr import profiles
    return profiles

log = logging.getLogger(__name__)

# Stored next to the flat overrides in the runtime config file, but not a
# Settings field, so the flat loader must skip them.
_PROFILE_STORE_KEYS: frozenset[str] = frozenset({"profiles", "active_profile"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    asr_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    asr_api_key: str = ""
    asr_model: str = "qwen3-asr-flash"
    asr_language: str | None = "zh"
    asr_timeout: float = 120.0
    asr_provider: str = "openai_compat"
    asr_timestamps: bool = True
    asr_hotwords: str = ""
    asr_prompt_hints: str = ""

    split_strategy: str = Field("silence", pattern="^(fixed|silence|overlap)$")
    split_chunk_seconds: float = Field(30.0, gt=0)
    split_overlap_seconds: float = Field(2.0, ge=0)
    silence_noise_db: float = -30.0
    silence_min_duration: float = 0.4

    asr_concurrency: int = 4
    asr_max_retries: int = 3
    asr_retry_backoff: float = 1.5

    ffmpeg_timeout: float = 1800.0  # per-ffmpeg-process wall-clock cap (anti-hang)
    ffmpeg_concurrency: int = 4  # max concurrent ffmpeg slice processes

    max_upload_bytes: int = 2 * 1024 * 1024 * 1024  # 2 GiB
    max_tasks_in_memory: int = 100
    task_ttl_seconds: int = 3600
    output_ttl_seconds: int = 7 * 24 * 3600

    # --- Realtime ---
    realtime_asr_provider: str = "realtime_mock"
    realtime_asr_base_url: str = ""
    realtime_asr_api_key: str = ""
    realtime_asr_model: str = ""
    realtime_session_ttl_seconds: int = 300
    # 并发闸门。上游 stream_max_sessions=8 只是"连接层"允许的上限，实测（2026-09-15
    # 参数扫掠：4 档 partial 节流 × 1/3/6/8 路）表明真正的约束是上游 generate 全局锁
    # 串行化推理：6 路时起稿要等 4.4s、10s 内只刷新 4 次；8 路等 6.5s，且 8 个客户端
    # 里只有 1 个能在 20s 内收到 done。调大节流参数救不了这一点（首字反而更慢）。
    # 4 路以内尾延迟 <2s、刷新 ≥6 次/10s，是"实时可用"的边界，故默认收紧到 4，
    # 让超出的请求拿到可控的 429，而不是让所有人一起变卡。
    realtime_max_sessions: int = 4
    realtime_max_chunk_bytes: int = 1024 * 1024  # 1 MiB per audio chunk
    realtime_max_session_bytes: int = 100 * 1024 * 1024  # 100 MiB per session
    realtime_max_session_seconds: int = 60 * 60  # 1 hour per session

    access_tokens: str = ""

    temp_dir: Path = Path("./temp")
    output_dir: Path = Path("./outputs")
    # 放在单独挂载的目录里：容器只持久化挂载出去的路径，放在镜像层里的话
    # `docker rm -f` 重建容器会把页面上保存的接入配置和密钥一起清掉。
    runtime_config_path: Path = Path("./config/runtime_config.json")

    host: str = "127.0.0.1"
    port: int = 8080
    log_level: str = "info"

    @model_validator(mode="after")
    def validate_split_parameters(self) -> "Settings":
        if (
            self.split_strategy == "overlap"
            and self.split_overlap_seconds >= self.split_chunk_seconds
        ):
            raise ValueError(
                "split_overlap_seconds must be less than split_chunk_seconds "
                "when split_strategy is overlap"
            )
        return self

    @property
    def access_tokens_list(self) -> list[str]:
        return [t.strip() for t in self.access_tokens.split(",") if t.strip()]

    @property
    def asr_hotwords_list(self) -> list[str]:
        return [w.strip() for w in self.asr_hotwords.split(",") if w.strip()]


# Fields the UI / API is allowed to change at runtime. Operational and dir
# fields stay env-only because changing them mid-flight is meaningless or
# dangerous.
WRITABLE_FIELDS: frozenset[str] = frozenset(
    {
        "asr_provider",
        "asr_base_url",
        "asr_api_key",
        "asr_model",
        "asr_language",
        "asr_timeout",
        "asr_timestamps",
        "asr_hotwords",
        "asr_prompt_hints",
        "asr_concurrency",
        "asr_max_retries",
        "asr_retry_backoff",
        "ffmpeg_timeout",
        "ffmpeg_concurrency",
        "split_strategy",
        "split_chunk_seconds",
        "split_overlap_seconds",
        "silence_noise_db",
        "silence_min_duration",
        "max_upload_bytes",
        "access_tokens",
        "realtime_asr_provider",
        "realtime_asr_base_url",
        "realtime_asr_api_key",
        "realtime_asr_model",
        "realtime_session_ttl_seconds",
        "realtime_max_sessions",
        "realtime_max_chunk_bytes",
        "realtime_max_session_bytes",
        "realtime_max_session_seconds",
        "output_ttl_seconds",
    }
)

# Never returned by GET /asr/config in cleartext. Only a `*_set` boolean.
SENSITIVE_FIELDS: frozenset[str] = frozenset(
    {"asr_api_key", "access_tokens", "realtime_asr_api_key"}
)


def _validated_runtime_overrides(settings: Settings, data: dict) -> tuple[dict, set[str]]:
    overrides = {k: v for k, v in data.items() if k in WRITABLE_FIELDS}
    invalid: set[str] = set()
    while True:
        merged = settings.model_dump()
        merged.update(overrides)
        try:
            validated = Settings.model_validate(merged)
            return {k: getattr(validated, k) for k in overrides}, invalid
        except ValidationError as exc:
            bad = {
                error["loc"][0]
                for error in exc.errors()
                if error.get("loc") and error["loc"][0] in overrides
            }
            if not bad:
                # Cross-field validation errors have an empty location. Keep
                # unrelated valid settings (especially credentials) when only
                # the split-parameter combination is invalid in the store.
                split_fields = {
                    "split_strategy",
                    "split_chunk_seconds",
                    "split_overlap_seconds",
                }
                if any(
                    "split_overlap_seconds must be less than split_chunk_seconds" in error.get("msg", "")
                    for error in exc.errors()
                ):
                    bad = split_fields.intersection(overrides)
                if not bad:
                    return {}, invalid | set(overrides)
            invalid.update(bad)
            for field in bad:
                overrides.pop(field)


def _load_runtime_overrides(path: Path, settings: Settings) -> dict:
    data = _read_store(path)
    overrides, invalid = _validated_runtime_overrides(settings, data)
    if not invalid:
        return overrides

    backup_path = path.with_name(path.name + ".bak")
    try:
        backup_bytes = backup_path.read_bytes()
        backup_data = _parse_store(backup_bytes)
    except OSError:
        backup_data = None
    if backup_data is not None:
        backup_overrides, backup_invalid = _validated_runtime_overrides(
            settings, backup_data
        )
        if not backup_invalid:
            log.warning("restoring invalid runtime overrides from %s", backup_path)
            try:
                _atomic_write_bytes(path, backup_bytes)
            except OSError:
                log.exception("failed to restore runtime config %s from backup", path)
            return backup_overrides

    log.warning("ignoring invalid runtime override fields: %s", sorted(invalid))
    return overrides


def _apply_to(settings: Settings, overrides: dict) -> None:
    for k, v in overrides.items():
        if k in WRITABLE_FIELDS:
            try:
                setattr(settings, k, v)
            except Exception:  # noqa: BLE001
                log.warning(
                    "failed to apply runtime override %s=%r", k, v, exc_info=True
                )


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.temp_dir.mkdir(parents=True, exist_ok=True)
    s.output_dir.mkdir(parents=True, exist_ok=True)
    _apply_to(s, _load_runtime_overrides(s.runtime_config_path, s))
    return s


def update_runtime_overrides(updates: dict) -> dict:
    """Validate, persist, and apply runtime overrides. Returns the applied dict."""
    s = get_settings()
    bad = [k for k in updates if k not in WRITABLE_FIELDS]
    if bad:
        raise ValueError(f"fields not writable: {bad}")

    # Validate once and apply normalized values (for example, integer strings).
    merged = s.model_dump()
    merged.update(updates)
    try:
        validated = Settings.model_validate(merged)
    except ValidationError as e:
        raise ValueError(str(e)) from e
    normalized = {k: getattr(validated, k) for k in updates}

    existing = _load_runtime_overrides(s.runtime_config_path, s)
    existing.update(normalized)
    # The file also holds the profile list, which is not a Settings field and
    # would be erased by rewriting it from the flat overrides alone.
    store = _read_store(s.runtime_config_path)
    for key in _PROFILE_STORE_KEYS:
        if key in store:
            existing[key] = store[key]
    _write_store(s.runtime_config_path, existing)

    _apply_to(s, normalized)
    return normalized


def _read_store(path: Path) -> dict:
    """The whole runtime config file, profile keys included."""
    if not path.is_file():
        return {}
    try:
        data = _parse_store(path.read_bytes())
    except OSError:
        data = None
    if data is not None:
        return data
    log.warning("runtime config %s is unreadable or not a JSON object", path)

    backup = path.with_name(path.name + ".bak")
    try:
        backup_bytes = backup.read_bytes()
        backup_data = _parse_store(backup_bytes)
    except OSError:
        return {}
    if backup_data is None:
        log.warning("runtime config backup %s is unreadable or invalid", backup)
        return {}

    log.warning("restoring runtime config %s from backup", path)
    try:
        _atomic_write_bytes(path, backup_bytes)
    except OSError:
        log.exception("failed to restore runtime config %s from backup", path)
    return backup_data


def _parse_store(data: bytes) -> dict | None:
    try:
        parsed = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            log.warning("failed to sync runtime config directory: %s", path.parent)
    finally:
        temp_path.unlink(missing_ok=True)


def _preserve_corrupt_file(path: Path) -> None:
    preserved = path.with_name(f"{path.name}.corrupt-{time.time_ns()}")
    os.replace(path, preserved)
    try:
        preserved.chmod(0o600)
    except OSError:
        log.warning("failed to restrict corrupt runtime config permissions: %s", preserved)


def _write_store(path: Path, data: dict, *, preserve_previous: bool = True) -> None:
    """Rewrite the runtime config, keeping the previous copy as ``<name>.bak``.

    The file holds API keys and the saved endpoint profiles, none of which are
    in git, so a bad write or a hand-edit must be recoverable from disk.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        current_bytes = path.read_bytes()
        if _parse_store(current_bytes) is not None:
            backup = path.with_name(path.name + ".bak")
            if preserve_previous:
                _atomic_write_bytes(backup, current_bytes)
            else:
                backup.unlink(missing_ok=True)
        else:
            _preserve_corrupt_file(path)
    else:
        path.with_name(path.name + ".bak").unlink(missing_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    _atomic_write_bytes(path, payload)


def _stored_profiles(store: dict) -> list[dict]:
    raw = store.get("profiles")
    if not isinstance(raw, list):
        return []
    return [p for p in raw if isinstance(p, dict) and isinstance(p.get("id"), str)]


def _backfill_legacy_realtime_fields(settings: Settings, store: dict) -> bool:
    """Add absent realtime endpoint fields to profiles saved before the split."""
    profiles = _stored_profiles(store)
    if not profiles:
        return False

    active = store.get("active_profile")
    active_realtime_id = active.get("realtime") if isinstance(active, dict) else None
    defaults = _profiles().REALTIME_PROFILE_DEFAULTS
    current_values = {
        field: getattr(settings, field)
        for field in _profiles().REALTIME_PROFILE_FIELDS
    }
    changed = False
    for profile in profiles:
        fallback = (
            current_values
            if profile["id"] == active_realtime_id
            else defaults
        )
        for field in _profiles().REALTIME_PROFILE_FIELDS:
            if field not in profile:
                profile[field] = fallback[field]
                changed = True
    if changed:
        store["profiles"] = profiles
    return changed


def get_profiles() -> dict:
    """Profiles plus which one each pipeline currently runs on.

    A deployment that predates profiles has none saved; its flat settings are
    persisted as a single "默认配置" on first read, so the id stays stable and
    the page is never empty.
    """
    s = get_settings()
    store = _read_store(s.runtime_config_path)
    profiles = _stored_profiles(store)
    if not profiles:
        profiles = [_profiles().profile_from_settings(s, name="默认配置")]
        store["profiles"] = profiles
        store["active_profile"] = {"file": profiles[0]["id"], "realtime": None}
        _write_store(s.runtime_config_path, store)
    elif _backfill_legacy_realtime_fields(s, store):
        _write_store(s.runtime_config_path, store)
    active = store.get("active_profile")
    if not isinstance(active, dict):
        active = {}
    return {
        "profiles": [_profiles().public_profile(p) for p in profiles],
        "file": active.get("file") if active.get("file") in {p["id"] for p in profiles} else profiles[0]["id"],
        "realtime": active.get("realtime") if active.get("realtime") in {p["id"] for p in profiles} else None,
    }


def save_profile(profile_id: str | None, fields: dict) -> dict:
    """Create or update a profile. An omitted key keeps its stored value, so a
    secret left blank in the form is not wiped."""
    s = get_settings()
    store = _read_store(s.runtime_config_path)
    profiles = _stored_profiles(store)
    _backfill_legacy_realtime_fields(s, store)
    profiles = _stored_profiles(store)

    name = _profiles().clean_name(fields.get("name"))
    if any(p["name"] == name and p["id"] != profile_id for p in profiles):
        raise ValueError(f"已有同名配置：{name}")

    current = next((p for p in profiles if p["id"] == profile_id), None)
    if profile_id is not None and current is None:
        raise ValueError("配置不存在")
    base = dict(current) if current else _profiles().profile_from_settings(s, name=name)

    updated = {
        "id": base["id"] if current else _profiles().new_profile_id(),
        "name": name,
    }
    for field in _profiles().ALL_PROFILE_FIELDS:
        updated[field] = fields[field] if field in fields else base.get(field)
    if not str(updated.get("asr_base_url") or "").strip():
        raise ValueError("接口地址不能为空")

    if current:
        profiles = [updated if p["id"] == current["id"] else p for p in profiles]
    else:
        profiles.append(updated)

    # The first profile ever saved becomes the file pipeline's profile, so the
    # flat settings the rest of the app reads keep matching what the page shows.
    active = store.get("active_profile")
    if not isinstance(active, dict) or "file" not in active:
        store["active_profile"] = {"file": updated["id"], "realtime": None}
        profile_updates = _profiles().profile_updates(updated, target="file")
        store.update(profile_updates)
    else:
        profile_updates = {}

    store["profiles"] = profiles
    _write_store(s.runtime_config_path, store)
    _apply_to(s, profile_updates)
    return _profiles().public_profile(updated)


def delete_profile(profile_id: str) -> None:
    s = get_settings()
    store = _read_store(s.runtime_config_path)
    profiles = _stored_profiles(store)
    if not any(p["id"] == profile_id for p in profiles):
        raise ValueError("配置不存在")
    if len(profiles) == 1:
        raise ValueError("至少保留一份配置")
    active = store.get("active_profile")
    if isinstance(active, dict) and profile_id in (active.get("file"), active.get("realtime")):
        raise ValueError("这份配置正在使用，先切换到别的再删除")
    store["profiles"] = [p for p in profiles if p["id"] != profile_id]
    _write_store(s.runtime_config_path, store)


def activate_profile(profile_id: str, target: str) -> dict:
    """Point a pipeline at a profile and copy it onto the flat settings."""
    s = get_settings()
    store = _read_store(s.runtime_config_path)
    _backfill_legacy_realtime_fields(s, store)
    profiles = _stored_profiles(store)
    profile = next((p for p in profiles if p["id"] == profile_id), None)
    if profile is None:
        raise ValueError("配置不存在")
    updates = _profiles().profile_updates(profile, target=target)
    active = store.get("active_profile")
    if not isinstance(active, dict):
        active = {}
    active[target] = profile_id
    store["active_profile"] = active
    store.update(updates)
    _write_store(s.runtime_config_path, store)
    _apply_to(s, updates)
    return updates


def reset_runtime_overrides() -> None:
    """Restore .env defaults on the live Settings.

    Saved profiles survive: "恢复默认" reverts the flat fields, not the list of
    endpoints the user set up.
    """
    s = get_settings()
    env_only = Settings()
    defaults = {field: getattr(env_only, field) for field in WRITABLE_FIELDS}
    store = _read_store(s.runtime_config_path)
    kept = {k: store[k] for k in _PROFILE_STORE_KEYS if k in store}
    _write_store(s.runtime_config_path, kept, preserve_previous=False)
    _apply_to(s, defaults)
