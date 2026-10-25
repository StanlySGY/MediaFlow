"""Shared cap on in-flight ASR provider calls.

Lifted out of `stream_manager` so every pipeline limits against the same setting
instead of each inventing its own accounting, and exposed through
`shared_call_limiter` so the cap is genuinely one number for the process:
two managers each holding their own limiter would allow 2 x asr_concurrency
provider calls in flight, which is exactly the burst the setting exists to stop.

Session capacity is deliberately *not* here: over-capacity sessions must be
refused synchronously (429), and counting plus registering has to be atomic,
which the session tables already do inside their own lock.
"""
from __future__ import annotations

import asyncio
import weakref
from dataclasses import dataclass, field

from app.config import Settings


@dataclass
class _LoopCount:
    """Counters for one event loop.

    `asyncio.Condition` binds to the loop it first sees and raises
    "is bound to a different event loop" on any other one. A limiter shared
    across managers is shared across the process, and tests run one fresh loop
    per case, so the condition has to be created per loop rather than once.
    """

    active: int = 0
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)


class ASRCallLimiter:
    """Dynamically sized cap on active provider calls, shared per event loop.

    Counters live per loop because the underlying Condition does; in production
    there is exactly one loop, so "per loop" and "for the whole app" coincide.

    The limit is read at acquire time rather than at construction, so a runtime
    change to `asr_concurrency` applies to the next call.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._counts: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, _LoopCount] = (
            weakref.WeakKeyDictionary()
        )

    def _count(self) -> _LoopCount:
        loop = asyncio.get_running_loop()
        count = self._counts.get(loop)
        if count is None:
            count = _LoopCount()
            self._counts[loop] = count
        return count

    async def __aenter__(self) -> "ASRCallLimiter":
        count = self._count()
        async with count.condition:
            await count.condition.wait_for(
                lambda: count.active < max(1, self._settings.asr_concurrency)
            )
            count.active += 1
        return self

    async def __aexit__(self, *_args) -> None:
        count = self._count()
        async with count.condition:
            count.active -= 1
            count.condition.notify_all()


def shared_call_limiter(settings: Settings) -> ASRCallLimiter:
    """One limiter for the whole process, built once per app.

    `create_app()` injects the returned instance into every manager that makes
    provider calls. Without injection each manager would hold its own limiter and
    the app would allow N x asr_concurrency calls in flight.
    """
    return ASRCallLimiter(settings)
