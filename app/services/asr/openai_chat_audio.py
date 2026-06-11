from __future__ import annotations

import asyncio
import base64
import logging
from pathlib import Path

import httpx

from app.services.asr.base import (
    ASRError,
    ASRProvider,
    ASRResult,
    RetryableASRError,
)

log = logging.getLogger(__name__)


class OpenAIChatAudioProvider:
    """ASR via OpenAI-compatible /v1/chat/completions with input_audio content.

    Targets multimodal LLMs serving as ASR (vLLM Qwen3-ASR-Flash, DashScope
    compat-mode chat with audio models). Audio is inlined as a base64
    `input_audio.data` data URI (`data:audio/wav;base64,...`).

    No word-level timestamps are returned in this surface; the merger falls
    back to LCS overlap dedupe and subtitles are per-chunk granularity.
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
        self._hotwords = list(hotwords) if hotwords else []
        self._prompt_hints = prompt_hints.strip()
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "OpenAIChatAudioProvider":
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(self._timeout),
            headers=headers,
        )
        return self

    async def __aexit__(self, *exc) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _build_body(self, audio_b64: str, per_call_prompt: str | None) -> dict:
        # DashScope's dedicated ASR task rejects system/text side-channel input.
        messages: list[dict] = [{
            "role": "user",
            "content": [
                {
                    "type": "input_audio",
                    "input_audio": {"data": f"data:audio/wav;base64,{audio_b64}"},
                },
            ],
        }]
        return {
            "model": self._model,
            "messages": messages,
            "asr_options": {"enable_itn": False},
        }

    async def transcribe(self, file_path: Path, *, prompt: str | None = None) -> ASRResult:
        if self._client is None:
            raise RuntimeError("provider must be used as async context manager")

        audio_b64 = base64.b64encode(file_path.read_bytes()).decode("ascii")
        body = self._build_body(audio_b64, prompt)

        last_err: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                resp = await self._client.post("/chat/completions", json=body)
                if resp.status_code >= 500 or resp.status_code == 429:
                    raise RetryableASRError(f"upstream {resp.status_code}: {resp.text[:200]}")
                if resp.status_code >= 400:
                    raise ASRError(f"client error {resp.status_code}: {resp.text[:200]}")
                return _parse_response(resp.json())
            except (httpx.TimeoutException, httpx.TransportError, RetryableASRError) as e:
                last_err = e
                if attempt >= self._max_retries:
                    break
                delay = self._retry_backoff ** attempt
                log.warning("asr retry %d/%d after %.1fs: %s", attempt + 1, self._max_retries, delay, e)
                await asyncio.sleep(delay)

        raise ASRError(f"transcribe failed after {self._max_retries + 1} attempts: {last_err}")


def _parse_response(payload: dict) -> ASRResult:
    choices = payload.get("choices") or []
    if not choices:
        raise ASRError("chat completion returned no choices")
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, list):
        # multimodal output, rare for pure ASR — concat any text parts
        text = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    else:
        text = (content or "").strip()
    return ASRResult(text=text, language=None, duration=None, words=[], raw=payload)


_: type[ASRProvider] = OpenAIChatAudioProvider
