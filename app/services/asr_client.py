"""Backward-compatible re-exports. New code should import from `app.services.asr`."""
from app.services.asr import (  # noqa: F401
    ASRError,
    ASRResult,
    OpenAICompatProvider as ASRClient,
)
