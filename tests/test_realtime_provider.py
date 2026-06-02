from __future__ import annotations


import pytest

from app.models.schemas import RealtimeAudioChunk, RealtimeSessionCreate
from app.services.asr.realtime_mock import RealtimeMockProvider


async def test_mock_emits_online_then_final_then_done():
    p = RealtimeMockProvider(online_every_n_chunks=2, online_text="part", final_text="all done")
    p.bind_session("s1")
    async with p:
        await p.start(RealtimeSessionCreate())
        for i in range(4):
            await p.push_audio(RealtimeAudioChunk(seq=i, audio="AAAA"))
        await p.finish()

        types: list[str] = []
        async for evt in p.events():
            types.append(evt.type)
        assert types == ["online", "online", "final", "done"]


async def test_mock_is_final_chunk_triggers_completion():
    p = RealtimeMockProvider()
    p.bind_session("s2")
    async with p:
        await p.start(RealtimeSessionCreate())
        await p.push_audio(RealtimeAudioChunk(seq=0, audio="AAAA"))
        await p.push_audio(RealtimeAudioChunk(seq=1, audio="", is_final=True))

        evts = []
        async for evt in p.events():
            evts.append(evt)
        # final + done at minimum
        assert evts[-2].type == "final"
        assert evts[-1].type == "done"
        assert evts[-2].text == "Mock final transcription."


async def test_mock_rejects_push_after_finish():
    p = RealtimeMockProvider()
    p.bind_session("s3")
    async with p:
        await p.start(RealtimeSessionCreate())
        await p.finish()
        from app.services.asr.realtime_base import RealtimeASRError
        with pytest.raises(RealtimeASRError):
            await p.push_audio(RealtimeAudioChunk(seq=1, audio="AAAA"))


def test_realtime_registry_resolves_mock_and_http():
    from app.config import Settings
    from app.services.asr import (
        create_realtime_provider, list_realtime_providers,
        RealtimeMockProvider, RealtimeHTTPProvider,
    )
    providers = list_realtime_providers()
    assert "realtime_mock" in providers
    assert "realtime_http" in providers

    mock = create_realtime_provider(Settings(realtime_asr_provider="realtime_mock"))
    assert isinstance(mock, RealtimeMockProvider)
    http = create_realtime_provider(Settings(
        realtime_asr_provider="realtime_http",
        realtime_asr_base_url="http://x/y",
    ))
    assert isinstance(http, RealtimeHTTPProvider)


def test_unknown_realtime_provider_raises():
    from app.config import Settings
    from app.services.asr import create_realtime_provider
    with pytest.raises(ValueError):
        create_realtime_provider(Settings(realtime_asr_provider="does-not-exist"))
