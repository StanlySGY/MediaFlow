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
    task_id: str
    segment_id: int
    start: float
    end: float
    text: str
    is_final: bool
    elapsed_ms: float = 0.0
    error: str | None = None


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
    model: str | None = None
    language: str | None = None
    sample_rate: int = 16000
    format: str = "pcm_s16le"
    channels: int = 1
    mode: str = "2pass"
    hotwords: list[str] = Field(default_factory=list)
    prompt_hints: str = ""


class RealtimeSessionInfo(BaseModel):
    session_id: str
    status: RealtimeSessionStatus
    events_url: str
    audio_url: str
    end_url: str
    created_at: float
    updated_at: float
    chunks_received: int = 0
    bytes_received: int = 0
    error: str | None = None


class RealtimeAudioChunk(BaseModel):
    seq: int = Field(ge=0)
    audio: str = ""
    sample_rate: int | None = None
    format: str | None = None
    channels: int | None = None
    is_final: bool = False


class RealtimeASREvent(BaseModel):
    """SSE event payload pushed to clients subscribed to a realtime session."""
    type: str  # online | final | done | error
    session_id: str
    seq: int | None = None
    text: str = ""
    is_final: bool = False
    elapsed_ms: float = 0.0
    mode: str | None = None
    error: str | None = None
    raw: dict | None = None
