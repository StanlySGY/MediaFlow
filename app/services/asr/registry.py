from __future__ import annotations

from typing import Callable

from app.config import Settings
from app.services.asr.base import ASRProvider
from app.services.asr.openai_chat_audio import OpenAIChatAudioProvider
from app.services.asr.openai_compat import OpenAICompatProvider


_REGISTRY: dict[str, Callable[[Settings], ASRProvider]] = {}


def register(name: str) -> Callable[[Callable[[Settings], ASRProvider]], Callable[[Settings], ASRProvider]]:
    def deco(factory: Callable[[Settings], ASRProvider]) -> Callable[[Settings], ASRProvider]:
        _REGISTRY[name] = factory
        return factory
    return deco


@register("openai_compat")
def _openai_compat(settings: Settings) -> ASRProvider:
    return OpenAICompatProvider(
        base_url=settings.asr_base_url,
        api_key=settings.asr_api_key,
        model=settings.asr_model,
        language=settings.asr_language,
        timeout=settings.asr_timeout,
        max_retries=settings.asr_max_retries,
        retry_backoff=settings.asr_retry_backoff,
        request_timestamps=settings.asr_timestamps,
        hotwords=settings.asr_hotwords_list,
        prompt_hints=settings.asr_prompt_hints,
    )


@register("openai_chat_audio")
def _openai_chat_audio(settings: Settings) -> ASRProvider:
    return OpenAIChatAudioProvider(
        base_url=settings.asr_base_url,
        api_key=settings.asr_api_key,
        model=settings.asr_model,
        language=settings.asr_language,
        timeout=settings.asr_timeout,
        max_retries=settings.asr_max_retries,
        retry_backoff=settings.asr_retry_backoff,
        hotwords=settings.asr_hotwords_list,
        prompt_hints=settings.asr_prompt_hints,
    )


def create_provider(settings: Settings) -> ASRProvider:
    name = settings.asr_provider
    if name not in _REGISTRY:
        raise ValueError(
            f"unknown ASR provider {name!r}; registered: {sorted(_REGISTRY)}"
        )
    return _REGISTRY[name](settings)


def list_providers() -> list[str]:
    return sorted(_REGISTRY)
