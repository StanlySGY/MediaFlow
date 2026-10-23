from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import httpx

from app.services.asr.base import (
    ASRError,
    ASRProvider,
    ASRResult,
    RetryableASRError,
    WordTime,
)
from app.services.asr.language import normalize_language
from app.services.asr_monitoring import asr_monitor

log = logging.getLogger(__name__)


class OpenAICompatProvider:
    """ASR provider speaking OpenAI's /audio/transcriptions format.

    Works with DashScope Qwen ASR (compatible-mode), OpenAI Whisper API,
    and any self-hosted server exposing the same shape (FunASR / SenseVoice
    behind an OpenAI shim, faster-whisper-server, etc.).
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        language: str | None = None,
        timeout: float = 120.0,
        max_retries: int = 3,
        retry_backoff: float = 1.5,
        request_timestamps: bool = True,
        hotwords: list[str] | None = None,
        prompt_hints: str = "",
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._language = language
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff
        self._request_timestamps = request_timestamps
        self._hotwords = list(hotwords) if hotwords else []
        self._prompt_hints = prompt_hints.strip()
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "OpenAICompatProvider":
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(self._timeout),
            headers={"Authorization": f"Bearer {self._api_key}"} if self._api_key else {},
        )
        return self

    async def __aexit__(self, *exc) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _build_prompt(self, per_call: str | None) -> str | None:
        parts: list[str] = []
        if self._prompt_hints:
            parts.append(self._prompt_hints)
        if self._hotwords:
            parts.append("、".join(self._hotwords))
        if per_call:
            parts.append(per_call)
        return " ".join(parts).strip() or None

    def _build_form(self, prompt: str | None) -> dict[str, str | list[str]]:
        form: dict[str, str | list[str]] = {"model": self._model}
        if self._request_timestamps:
            form["response_format"] = "verbose_json"
            form["timestamp_granularities[]"] = ["word", "segment"]
        else:
            form["response_format"] = "json"
        if language := normalize_language(self._language):
            form["language"] = language
        final_prompt = self._build_prompt(prompt)
        if final_prompt:
            form["prompt"] = final_prompt
        return form

    async def transcribe(self, file_path: Path, *, prompt: str | None = None) -> ASRResult:
        if self._client is None:
            raise RuntimeError("provider must be used as async context manager")

        form = self._build_form(prompt)
        content = file_path.read_bytes()
        call_id = asr_monitor.start_call(
            provider="openai_compat",
            model=self._model,
            base_url=self._base_url,
            request_bytes=len(content),
        )
        last_err: Exception | None = None
        try:
            for attempt in range(self._max_retries + 1):
                try:
                    files = {"file": (file_path.name, content, "audio/wav")}
                    resp = await self._client.post(
                        "/audio/transcriptions", data=form, files=files,
                    )
                    if resp.status_code >= 500 or resp.status_code == 429:
                        raise RetryableASRError(f"upstream {resp.status_code}: {resp.text[:200]}")
                    if resp.status_code >= 400:
                        raise ASRError(f"client error {resp.status_code}: {resp.text[:200]}")
                    result = _parse_response(resp.json())
                    asr_monitor.finish_call(
                        call_id,
                        ok=True,
                        text_chars=len(result.text),
                        text_preview=result.text,
                    )
                    return result
                except (httpx.TimeoutException, httpx.TransportError, RetryableASRError) as e:
                    last_err = e
                    if attempt >= self._max_retries:
                        break
                    delay = min(self._retry_backoff ** attempt, 30.0)
                    log.warning("asr retry %d/%d after %.1fs: %s", attempt + 1, self._max_retries, delay, e)
                    await asyncio.sleep(delay)

            raise ASRError(f"transcribe failed after {self._max_retries + 1} attempts: {last_err}")
        except asyncio.CancelledError:
            # Cancellation is a BaseException, not an Exception. Close the monitor
            # row before propagating it so abandoned requests do not stay "running".
            asr_monitor.finish_call(call_id, ok=False, error="ASR call cancelled")
            raise
        except Exception as e:
            asr_monitor.finish_call(call_id, ok=False, error=str(e))
            raise


def _speaker_of(entry: dict) -> str | None:
    """Speaker label as various upstreams spell it. None when the upstream does
    not do diarization at all — that is the normal case, not an error."""
    for key in ("speaker", "speaker_id", "speaker_label"):
        value = entry.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _parse_response(payload: dict) -> ASRResult:
    text = (payload.get("text") or "").strip()
    words_raw = payload.get("words") or []
    words = [
        WordTime(
            word=w.get("word", ""),
            start=float(w.get("start", 0.0)),
            end=float(w.get("end", 0.0)),
            speaker=_speaker_of(w),
        )
        for w in words_raw
        if "start" in w and "end" in w
    ]
    # verbose_json segments: the request asks for segment granularity (see
    # _build_form), so the payload's `segments` is the diarization carrier for
    # upstreams that label speakers per segment rather than per word. Without
    # this the timestamps and speaker tags are paid for in upstream bandwidth
    # and dropped: only `words` ever reached the merger, which is what decides
    # whether the transcript keeps speaker labels at all (merger._join_words).
    #
    # Segments fill a word entry only where there is no per-word timing, so a
    # word-level stream is never overwritten by coarser segment text.
    if not words:
        segments_raw = payload.get("segments") or []
        words = [
            WordTime(
                word=seg.get("text", ""),
                start=float(seg.get("start", 0.0)),
                end=float(seg.get("end", 0.0)),
                speaker=_speaker_of(seg),
            )
            for seg in segments_raw
            if seg.get("text") and "start" in seg and "end" in seg
        ]
    if not text:
        # Some upstreams return only segments under verbose_json.
        text = "".join(w.word for w in words).strip()
    return ASRResult(
        text=text,
        language=payload.get("language"),
        duration=payload.get("duration"),
        words=words,
        raw=payload,
    )


# Static type assertion that this class satisfies the protocol.
_: type[ASRProvider] = OpenAICompatProvider
