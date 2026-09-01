"""运行期配置：全部通过环境变量（ASR_ 前缀）注入，便于容器化部署。"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ASR_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        protected_namespaces=(),
    )

    # ---------------- 服务 ----------------
    host: str = "0.0.0.0"
    port: int = 8022
    workers: int = 1
    api_key: str = ""  # 非空则校验 Authorization: Bearer / X-API-Key
    cors_origins: str = "*"
    log_level: str = "INFO"

    # ---------------- 模型 ----------------
    model_path: str = "/home/models/Qwen3-ASR-1.7B"
    backend: Literal["auto", "transformers", "qwen_asr"] = "auto"
    dtype: Literal["bfloat16", "float16", "float32"] = "bfloat16"
    max_new_tokens: int = 256
    default_language: str = ""  # 空 = 自动检测；可填 "zh" / "Chinese" / "en" ...
    attn_implementation: str = "eager"  # NPU 上 sdpa/flash 未必可用，默认 eager 最稳

    # ---------------- 设备（昇腾 NPU） ----------------
    device: Literal["npu", "cpu", "cuda"] = "npu"
    npu_device_id: int = 0
    npu_jit_compile: bool = False
    npu_allow_internal_format: bool = False
    warmup: bool = True

    # ---------------- 音频 ----------------
    sample_rate: int = 16000
    max_audio_seconds: float = 600.0
    ffmpeg_bin: str = "ffmpeg"

    # ---------------- 流式 ----------------
    stream_partial_enabled: bool = True
    stream_partial_interval_ms: int = 640  # 两次 partial 推理的最小间隔
    stream_min_partial_ms: int = 480       # 语音累计多长才开始出 partial
    stream_max_sessions: int = 8
    stream_recv_timeout_s: float = 300.0
    stream_token_level: bool = True        # generate 过程中逐 token 推送

    # ---------------- VAD（纯 numpy 能量 + 过零率，无需额外编译依赖） ----------------
    vad_enabled: bool = True
    vad_frame_ms: int = 20
    vad_energy_threshold: float = 0.012    # RMS 阈值（归一化到 [-1,1] 之后）
    vad_adaptive: bool = True              # 基于噪声底自适应抬高阈值
    vad_silence_ms: int = 700              # 静音多久判定一句话结束
    vad_min_speech_ms: int = 300           # 过短的语音段丢弃
    vad_speech_pad_ms: int = 200           # 语音段前后各留一点余量
    segment_max_ms: int = 25000            # 单段最长，超过强制切分定稿

    # ---------------- 并发 ----------------
    max_concurrency: int = 2               # 同时进入 NPU 推理的最大请求数
    partial_concurrency: int = 1           # partial 推理单独限流，避免抢占 final

    @field_validator("default_language")
    @classmethod
    def _empty_lang(cls, v: str) -> str:
        return v.strip()

    @property
    def language_or_none(self) -> Optional[str]:
        return self.default_language or None

    @property
    def cors_list(self) -> list[str]:
        if self.cors_origins.strip() in ("*", ""):
            return ["*"]
        return [x.strip() for x in self.cors_origins.split(",") if x.strip()]

    @property
    def torch_device(self) -> str:
        if self.device == "npu":
            return f"npu:{self.npu_device_id}"
        if self.device == "cuda":
            return f"cuda:{self.npu_device_id}"
        return "cpu"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
