from __future__ import annotations

from enum import Enum
from pathlib import Path

from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
    pending = "pending"
    preprocessing = "preprocessing"
    splitting = "splitting"
    transcribing = "transcribing"
    merging = "merging"
    done = "done"
    failed = "failed"


class Word(BaseModel):
    word: str
    start: float
    end: float


class Segment(BaseModel):
    segment_id: int
    start: float
    end: float
    file_path: Path
    text: str = ""
    is_final: bool = False
    error: str | None = None
    words: list[Word] = Field(default_factory=list)
    elapsed_ms: float = 0.0
    raw: dict | None = None

    @property
    def duration(self) -> float:
        return self.end - self.start


class SegmentEvent(BaseModel):
    """SSE payload streamed to clients."""
    task_id: str = Field(
        description=(
            "文件转写任务 ID。每条 segment 事件都会带出，便于事件归属、断线恢复"
            "和切页面后找回任务；可靠来源仍是 POST /asr/file 的响应。"
        )
    )
    segment_id: int = Field(description="分片序号。")
    start: float = Field(description="分片开始时间，单位秒。")
    end: float = Field(description="分片结束时间，单位秒。")
    text: str = Field(description="当前分片识别文本。")
    is_final: bool = Field(description="当前分片文本是否为最终结果。")
    elapsed_ms: float = Field(default=0.0, description="当前分片识别耗时，单位毫秒。")
    error: str | None = Field(default=None, description="当前分片错误信息；正常时为空。")


class TaskResult(BaseModel):
    task_id: str
    status: TaskStatus
    duration: float = 0.0
    language: str | None = None
    text: str = ""
    segments: list[Segment] = Field(default_factory=list)
    error: str | None = None


class TaskInfo(BaseModel):
    task_id: str
    status: TaskStatus
    progress: float = 0.0
    total_segments: int = 0
    finished_segments: int = 0
    error: str | None = None


# ---------------- Realtime ----------------

class RealtimeSessionStatus(str, Enum):
    starting = "starting"
    active = "active"
    finishing = "finishing"
    done = "done"
    failed = "failed"
    closed = "closed"


class RealtimeSessionCreate(BaseModel):
    model: str | None = Field(
        default=None,
        description="本次实时会话指定的模型名称；留空使用服务端 ASR_MODEL 默认配置。",
    )
    language: str | None = Field(
        default=None,
        description="识别语言，例如 zh / en；留空表示自动识别或使用服务端默认值。",
    )
    sample_rate: int = Field(
        default=16000,
        description="音频采样率，PCM 实时录音通常使用 16000。",
    )
    format: str = Field(
        default="pcm_s16le",
        description=(
            "上传音频格式。实时录音推荐 pcm_s16le；如果一次性上传 WAV "
            "base64，可填 wav。"
        ),
    )
    channels: int = Field(default=1, description="声道数，常见实时录音为 1。")
    mode: str = Field(
        default="2pass",
        description="下游实时 ASR 模式透传字段；realtime_offline 会忽略该值。",
    )
    hotwords: list[str] = Field(
        default_factory=list,
        description="热词列表，用于下游支持热词的实时服务；不支持时会被忽略。",
    )
    prompt_hints: str = Field(
        default="",
        description="上下文提示词；realtime_offline 会作为 prompt 传给文件 ASR provider。",
    )


class RealtimeSessionInfo(BaseModel):
    session_id: str = Field(description="实时会话 ID，后续推送音频和订阅 SSE 都要使用。")
    status: RealtimeSessionStatus = Field(description="会话状态。")
    events_url: str = Field(description="SSE 事件流地址。")
    audio_url: str = Field(description="base64 音频 chunk 推送地址。")
    end_url: str = Field(description="主动结束会话地址。")
    created_at: float = Field(description="会话创建时间戳。")
    updated_at: float = Field(description="会话最近更新时间戳。")
    chunks_received: int = Field(default=0, description="已收到的音频 chunk 数量。")
    bytes_received: int = Field(default=0, description="已收到的音频解码后字节数。")
    error: str | None = Field(default=None, description="失败原因；正常时为空。")


class RealtimeAudioChunk(BaseModel):
    seq: int = Field(
        ge=0,
        description="客户端递增序号，用于排查丢包或乱序；建议从 1 开始。",
        examples=[1],
    )
    audio: str = Field(
        default="",
        description=(
            "base64 编码的音频片段。普通 chunk 必填；最后一个结束包可以为空字符串。"
        ),
        examples=["UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="],
    )
    sample_rate: int | None = Field(
        default=None,
        description="可选单包采样率覆盖；通常创建会话时统一指定即可。",
    )
    format: str | None = Field(
        default=None,
        description="可选单包格式覆盖，例如 pcm_s16le / wav；通常创建会话时统一指定即可。",
    )
    channels: int | None = Field(
        default=None,
        description="可选单包声道数覆盖；通常创建会话时统一指定即可。",
    )
    is_final: bool = Field(
        default=False,
        description=(
            "是否最后一个包。true 表示音频已发完，服务端开始结束识别并输出 final/done。"
        ),
    )


class RealtimeASREvent(BaseModel):
    """SSE event payload pushed to clients subscribed to a realtime session."""
    type: str = Field(description="事件类型：online / final / done / error。")
    session_id: str = Field(description="实时会话 ID。")
    seq: int | None = Field(default=None, description="事件序号；并非所有 provider 都会返回。")
    text: str = Field(default="", description="识别文本。online 为中间结果，final 为最终结果。")
    is_final: bool = Field(default=False, description="当前文本是否最终结果。")
    elapsed_ms: float = Field(default=0.0, description="从会话开始到当前事件的耗时，单位毫秒。")
    mode: str | None = Field(
        default=None,
        description=(
            "流式模式标记。simulated_streaming 表示底层是离线 ASR，网关模拟 SSE 流式返回。"
        ),
    )
    error: str | None = Field(default=None, description="错误信息；仅 error 事件有值。")
    raw: dict | None = Field(default=None, description="下游原始事件，调试用。")
