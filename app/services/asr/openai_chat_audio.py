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
    WordTime,
    RetryableASRError,
)
from app.services.asr.inline_budget import check_inline_audio
from app.services.asr.language import normalize_language
from app.services.asr_monitoring import asr_monitor

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
        max_inline_audio_bytes: int = 0,
        max_inline_audio_seconds: float = 0.0,
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
        self._max_inline_audio_bytes = max_inline_audio_bytes
        self._max_inline_audio_seconds = max_inline_audio_seconds
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
                    "input_audio": {
                        "data": f"data:audio/wav;base64,{audio_b64}",
                        "format": "wav",
                    },
                },
            ],
        }]
        body: dict = {
            "model": self._model,
            "messages": messages,
        }
        # 官方 qwen-asr 客户端强制语言的做法：在 assistant 提示里前置
        # "language Chinese<asr_text>"，模型就只输出文本、不再自判语种。
        if language := normalize_language(self._language):
            body["messages"] = [
                {"role": "assistant", "content": f"language {language}<asr_text>"},
                *messages,
            ]
        return body

    async def _guard_inline_audio(self, file_path: Path) -> bytes:
        """Refuse audio that cannot be inlined, then read it.

        The audio becomes a base64 string inside a JSON body, so the whole
        payload has to exist in memory at once and in several copies: file bytes,
        the base64 str (1.33x), the data-URI (1.33x), the JSON body (1.33x) and
        httpx's own copy of it — measured peak 6.7x the file with all of them
        alive, and paid again on every retry. `openai_compat`
        streams the same file from a handle; this provider cannot, so an over-cap
        file has to be refused before it is read rather than paid for and sent.

        The caps are the configured ones, and the caller's batch sizing
        (`app.services.audio_budget`) is derived from the seconds cap, so a
        normally-split file never trips either check.
        """
        await check_inline_audio(
            file_path,
            max_seconds=self._max_inline_audio_seconds,
            max_bytes=self._max_inline_audio_bytes,
            timeout=self._timeout,
        )
        return file_path.read_bytes()

    async def transcribe(self, file_path: Path, *, prompt: str | None = None) -> ASRResult:
        if self._client is None:
            raise RuntimeError("provider must be used as async context manager")

        content = await self._guard_inline_audio(file_path)
        audio_b64 = base64.b64encode(content).decode("ascii")
        body = self._build_body(audio_b64, prompt)
        call_id = asr_monitor.start_call(
            provider="openai_chat_audio",
            model=self._model,
            base_url=self._base_url,
            request_bytes=len(content),
        )

        last_err: Exception | None = None
        try:
            for attempt in range(self._max_retries + 1):
                try:
                    resp = await self._client.post("/chat/completions", json=body)
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
            # Cancelled requests must leave monitoring in a terminal state too.
            asr_monitor.finish_call(call_id, ok=False, error="ASR call cancelled")
            raise
        except Exception as e:
            asr_monitor.finish_call(call_id, ok=False, error=str(e))
            raise


def _parse_response(payload: dict) -> ASRResult:
    import re

    choices = payload.get("choices") or []
    if not choices:
        raise ASRError("chat completion returned no choices")
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, list):
        text = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    else:
        text = (content or "").strip()

    # Parse vLLM Qwen3-ASR format: "language Chinese<asr_text>识别文本"
    language = None
    m = re.match(r"language\s+(\S+)<asr_text>(.*)", text, re.DOTALL)
    if m:
        language = m.group(1)
        text = m.group(2).strip()

    # Parse segments with speaker info if available
    segments_data = payload.get("segments") or []
    words = []
    if segments_data:
        for seg in segments_data:
            speaker = seg.get("speaker") or seg.get("speaker_id")
            start = seg.get("start", 0.0)
            end = seg.get("end", 0.0)
            seg_text = seg.get("text", "")
            if seg_text:
                words.append(WordTime(
                    word=seg_text,
                    start=start,
                    end=end,
                    speaker=speaker,
                ))

    # If no segments but text contains speaker labels, parse them
    if not words and text:
        import re
        # Match patterns like [SPEAKER_00] text or [说话人1] text
        speaker_pattern = re.compile(r'\[([^\]]+)\]\s*')
        parts = speaker_pattern.split(text)
        if len(parts) > 1:
            current_speaker = None
            i = 0
            while i < len(parts):
                if i % 2 == 1:  # Odd indices are speaker labels
                    current_speaker = parts[i]
                else:
                    seg_text = parts[i].strip()
                    if seg_text:
                        words.append(WordTime(
                            word=seg_text,
                            start=0.0,
                            end=0.0,
                            speaker=current_speaker,
                        ))
                i += 1

    return ASRResult(text=text, language=language, duration=None, words=words, raw=payload)


_: type[ASRProvider] = OpenAIChatAudioProvider
