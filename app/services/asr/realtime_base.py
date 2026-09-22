from __future__ import annotations

from typing import AsyncIterator, Protocol

from app.models.schemas import RealtimeASREvent, RealtimeAudioChunk, RealtimeSessionCreate


class RealtimeASRError(RuntimeError):
    pass


class RealtimeASRProvider(Protocol):
    """Pluggable realtime ASR backend.

    Lifecycle: `__aenter__` → `start(config)` → repeated `push_audio(chunk)`
    → `finish()` → drain `events()` → `__aexit__`.

    The provider drives a background task that produces RealtimeASREvent
    objects readable via `events()`. Provider events use the canonical types
    `online`, `final`, `done`, and `error`; `final`/`done` are terminal-success
    stages, while `error` is terminal-failure. `is_final` must be true only for
    `final` and `done` events. `seq`, when present, is provider-local and must
    be non-negative; providers that synthesize events should emit a monotonic
    sequence. The implementation must terminate the event stream by yielding
    a `done` (or `error`) event after `finish()` completes so consumers can exit
    cleanly.
    """

    async def __aenter__(self) -> "RealtimeASRProvider": ...
    async def __aexit__(self, *exc) -> None: ...
    async def start(self, config: RealtimeSessionCreate) -> None: ...
    async def push_audio(self, chunk: RealtimeAudioChunk) -> None: ...
    async def finish(self) -> None: ...
    def events(self) -> AsyncIterator[RealtimeASREvent]: ...
