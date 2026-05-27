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
