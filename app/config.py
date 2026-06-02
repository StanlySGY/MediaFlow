from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)


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
    split_chunk_seconds: float = 30.0
    split_overlap_seconds: float = 2.0
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

    # --- Realtime ---
    realtime_asr_provider: str = "realtime_mock"
    realtime_asr_base_url: str = ""
    realtime_asr_api_key: str = ""
    realtime_asr_model: str = ""
    realtime_session_ttl_seconds: int = 300
    realtime_max_sessions: int = 100
    realtime_max_chunk_bytes: int = 1024 * 1024  # 1 MiB per audio chunk

    access_tokens: str = ""

    temp_dir: Path = Path("./temp")
    output_dir: Path = Path("./outputs")
    runtime_config_path: Path = Path("./runtime_config.json")

    host: str = "0.0.0.0"
    port: int = 8999
    log_level: str = "info"

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
    }
)

# Never returned by GET /asr/config in cleartext. Only a `*_set` boolean.
SENSITIVE_FIELDS: frozenset[str] = frozenset(
    {"asr_api_key", "access_tokens", "realtime_asr_api_key"}
)


def _load_runtime_overrides(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            log.warning("runtime overrides at %s is not a JSON object, ignoring", path)
            return {}
        return {k: v for k, v in data.items() if k in WRITABLE_FIELDS}
    except Exception:  # noqa: BLE001
        log.warning("failed to load runtime overrides from %s", path, exc_info=True)
        return {}


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
    _apply_to(s, _load_runtime_overrides(s.runtime_config_path))
    return s


def update_runtime_overrides(updates: dict) -> dict:
    """Validate, persist, and apply runtime overrides. Returns the applied dict."""
    s = get_settings()
    bad = [k for k in updates if k not in WRITABLE_FIELDS]
    if bad:
        raise ValueError(f"fields not writable: {bad}")

    # Force pydantic field validation by validating a merged dict.
    merged = s.model_dump()
    merged.update(updates)
    try:
        Settings.model_validate(merged)
    except ValidationError as e:
        raise ValueError(str(e)) from e

    existing = _load_runtime_overrides(s.runtime_config_path)
    existing.update(updates)
    s.runtime_config_path.parent.mkdir(parents=True, exist_ok=True)
    s.runtime_config_path.write_text(
        json.dumps(existing, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    _apply_to(s, updates)
    return updates


def reset_runtime_overrides() -> None:
    """Delete the runtime config file and restore .env defaults on the live Settings."""
    s = get_settings()
    s.runtime_config_path.unlink(missing_ok=True)
    env_only = Settings()
    for field in WRITABLE_FIELDS:
        setattr(s, field, getattr(env_only, field))
