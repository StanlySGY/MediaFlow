from __future__ import annotations

from typing import AsyncIterator, Protocol

from app.models.schemas import RealtimeASREvent, RealtimeAudioChunk, RealtimeSessionCreate


class RealtimeASRError(RuntimeError):
    """Provider or session failure with a stable client-facing code.

    `code` is one of: invalid_request, unauthorized, session_not_found,
    session_expired, session_limit, provider_unavailable, provider_timeout,
    provider_rejected, audio_invalid, internal_error, cancelled, interrupted.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        hint: str | None = None,
        retryable: bool | None = None,
    ) -> None:
        super().__init__(message)
        inferred_code, inferred_hint, inferred_retryable = classify_message(message)
        self.code = code or inferred_code
        self.hint = inferred_hint if hint is None else hint
        self.retryable = inferred_retryable if retryable is None else retryable


def classify_message(message: str) -> tuple[str, str | None, bool]:
    """Map a provider or gateway error string onto the public error protocol."""
    low = message.lower()
    if "同时录音已达上限" in message:
        return "session_limit", "请等待他人结束录音后重试", True
    if "session not found" in low or "未知会话" in message:
        return "session_not_found", "请确认会话是否已结束", False
    if (
        "already closed" in low
        or "already finished" in low
        or "session expired" in low
        or "会话已结束" in message
    ):
        return "session_expired", "会话已结束，请重新开始录音", False
    if (
        "invalid base64" in low
        or "invalid audio" in low
        or "no audio received" in low
        or "audio input is closed" in low
    ):
        return "audio_invalid", "检查音频格式、采样率和编码", False
    if "401" in message or "403" in message or "unauthorized" in low:
        return "unauthorized", "检查上游 API Key 是否正确", False
    if "timed out" in low or "timeout" in low:
        return "provider_timeout", "上游响应超时，可稍后重试", True
    if any(
        token in low
        for token in (
            "connection refused",
            "connecterror",
            "unavailable",
            "name or service not known",
            "network is unreachable",
            "failed to start",
        )
    ):
        return "provider_unavailable", "上游实时识别服务不可达，可稍后重试", True
    if any(token in low for token in ("invalid request", "missing filename", "422")):
        return "invalid_request", "检查请求参数", False
    if any(
        token in low
        for token in ("downstream", "rejected", " 400", " 404", " 409", " 500", " 502")
    ):
        return "provider_rejected", "上游拒绝了这次识别", False
    return "internal_error", None, False


def error_payload(exc: BaseException) -> dict[str, str | bool | None]:
    """`code` / `message` / `hint` / `retryable` for an HTTP or SSE error."""
    if isinstance(exc, RealtimeASRError):
        return {
            "code": exc.code,
            "message": str(exc),
            "hint": exc.hint,
            "retryable": exc.retryable,
        }
    code, hint, retryable = classify_message(str(exc))
    return {"code": code, "message": str(exc), "hint": hint, "retryable": retryable}


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
