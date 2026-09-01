"""API 数据模型。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class TranscriptionResponse(BaseModel):
    """OpenAI /v1/audio/transcriptions 兼容响应（附加昇腾侧性能字段）。"""

    text: str = ""
    language: Optional[str] = None
    duration: float = Field(0.0, description="音频时长（秒）")
    infer_ms: float = Field(0.0, description="推理耗时（毫秒）")
    rtf: float = Field(0.0, description="实时率 = 推理耗时 / 音频时长，越小越快")
    segments: Optional[List[Dict[str, Any]]] = None


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    backend: str
    device: str
    uptime_s: float


class InfoResponse(BaseModel):
    service: str = "qwen3-asr-npu"
    version: str
    model_path: str
    backend: str
    device: str
    dtype: str
    npu_available: bool
    torch_version: str
    torch_npu_version: str
    transformers_version: str
    load_seconds: float
    sample_rate: int
    max_new_tokens: int
    default_language: Optional[str] = None
    stream: Dict[str, Any] = Field(default_factory=dict)
    active_sessions: int = 0


class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None
