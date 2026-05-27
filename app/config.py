from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    asr_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    asr_api_key: str = ""
    asr_model: str = "qwen3-asr-flash"
    asr_language: str | None = "zh"
    asr_timeout: float = 120.0

    split_strategy: str = Field("silence", pattern="^(fixed|silence|overlap)$")
    split_chunk_seconds: float = 30.0
    split_overlap_seconds: float = 2.0
    silence_noise_db: float = -30.0
    silence_min_duration: float = 0.4

    asr_concurrency: int = 4
    asr_max_retries: int = 3
    asr_retry_backoff: float = 1.5

    max_upload_bytes: int = 2 * 1024 * 1024 * 1024  # 2 GiB
    max_tasks_in_memory: int = 100
    task_ttl_seconds: int = 3600

    temp_dir: Path = Path("./temp")
    output_dir: Path = Path("./outputs")

    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "info"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.temp_dir.mkdir(parents=True, exist_ok=True)
    s.output_dir.mkdir(parents=True, exist_ok=True)
    return s
