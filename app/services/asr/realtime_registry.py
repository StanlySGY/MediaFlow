from __future__ import annotations

from typing import Callable

from app.config import Settings
from app.services.asr.realtime_base import RealtimeASRProvider
from app.services.asr.realtime_http import RealtimeHTTPProvider
from app.services.asr.realtime_mock import RealtimeMockProvider
from app.services.asr.realtime_offline import RealtimeOfflineProvider


_REGISTRY: dict[str, Callable[[Settings], RealtimeASRProvider]] = {}


def register_realtime(name: str) -> Callable[[Callable[[Settings], RealtimeASRProvider]], Callable[[Settings], RealtimeASRProvider]]:
    def deco(factory):
        _REGISTRY[name] = factory
        return factory
    return deco


@register_realtime("realtime_mock")
def _mock(settings: Settings) -> RealtimeASRProvider:
    return RealtimeMockProvider()


@register_realtime("realtime_http")
def _http(settings: Settings) -> RealtimeASRProvider:
    return RealtimeHTTPProvider(
        base_url=settings.realtime_asr_base_url,
        api_key=settings.realtime_asr_api_key,
        model=settings.realtime_asr_model,
        timeout=settings.asr_timeout,
    )


@register_realtime("realtime_offline")
def _offline(settings: Settings) -> RealtimeASRProvider:
    return RealtimeOfflineProvider(settings)


def create_realtime_provider(settings: Settings) -> RealtimeASRProvider:
    name = settings.realtime_asr_provider
    if name not in _REGISTRY:
        raise ValueError(
            f"unknown realtime ASR provider {name!r}; registered: {sorted(_REGISTRY)}"
        )
    return _REGISTRY[name](settings)


def list_realtime_providers() -> list[str]:
    return sorted(_REGISTRY)
