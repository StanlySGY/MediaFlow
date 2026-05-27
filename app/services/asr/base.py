from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


class ASRError(RuntimeError):
    pass


class RetryableASRError(ASRError):
    """Transient upstream failure (5xx / 429 / network). Caller may retry."""


@dataclass(frozen=True)
class WordTime:
    word: str
    start: float
    end: float


@dataclass(frozen=True)
class ASRResult:
    text: str
    language: str | None = None
    duration: float | None = None
    words: list[WordTime] = field(default_factory=list)
    raw: dict | None = None


class ASRProvider(Protocol):
    """Pluggable ASR backend. Implementations must be usable as async context managers."""

    async def __aenter__(self) -> "ASRProvider": ...
    async def __aexit__(self, *exc) -> None: ...
    async def transcribe(self, file_path: Path, *, prompt: str | None = None) -> ASRResult: ...
