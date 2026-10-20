from __future__ import annotations

import pytest
import httpx
import respx

from app.models.schemas import RealtimeAudioChunk, RealtimeSessionCreate
from app.services.asr.realtime_base import RealtimeASRError
from app.services.asr.realtime_http import RealtimeHTTPProvider
from app.services.asr.realtime_mock import RealtimeMockProvider


async def test_mock_emits_online_then_final_then_done():
    p = RealtimeMockProvider(online_every_n_chunks=2, online_text="part", final_text="all done")
    p.bind_session("s1")
    async with p:
        await p.start(RealtimeSessionCreate())
        for i in range(4):
            await p.push_audio(RealtimeAudioChunk(seq=i, audio="AAAA"))
        await p.finish()

        evts = [evt async for evt in p.events()]
        assert [evt.type for evt in evts] == ["online", "online", "final", "done"]
        assert [evt.seq for evt in evts] == [0, 1, 2, 3]


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


@respx.mock
async def test_http_finish_propagates_downstream_end_failure():
    respx.post("https://example.test/session").mock(
        return_value=httpx.Response(200, json={"session_id": "down-1"})
    )
    end_route = respx.post("https://example.test/session/down-1/end").mock(
        return_value=httpx.Response(503, text="overloaded")
    )

    provider = RealtimeHTTPProvider(base_url="https://example.test")
    provider.bind_session("local-1")
    async with provider:
        await provider.start(RealtimeSessionCreate())
        with pytest.raises(RealtimeASRError, match="downstream /end failed 503"):
            await provider.finish()

    assert end_route.call_count == 2  # context teardown retries after the first 503


async def test_http_finish_cancellation_is_retryable():
    import asyncio

    class _Response:
        status_code = 200

    class _Client:
        calls = 0

        async def post(self, _path):
            self.calls += 1
            if self.calls == 1:
                started.set()
                await asyncio.Event().wait()
            return _Response()

    started = asyncio.Event()
    client = _Client()
    provider = RealtimeHTTPProvider(base_url="https://example.test")
    provider._client = client
    provider._down_session_id = "down-cancel"

    finishing = asyncio.create_task(provider.finish())
    await asyncio.wait_for(started.wait(), timeout=2)
    finishing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.shield(finishing)

    assert provider._finished is False
    await provider.finish()
    assert client.calls == 2
    assert provider._finished is True


async def test_offline_finish_cancellation_terminates_event_stream(tmp_path, monkeypatch):
    import asyncio

    from app.config import Settings
    from app.services.asr.base import ASRResult
    from app.services.asr.realtime_offline import RealtimeOfflineProvider

    started = asyncio.Event()
    audio_path = tmp_path / "input.wav"
    audio_path.write_bytes(b"audio")

    class _BlockingASR:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return None

        async def transcribe(self, _path, *, prompt=None):
            started.set()
            await asyncio.Event().wait()
            return ASRResult(text="never returned")

    settings = Settings(temp_dir=tmp_path / "temp", output_dir=tmp_path / "out")
    provider = RealtimeOfflineProvider(
        settings, provider_factory=lambda _settings: _BlockingASR()
    )
    provider.bind_session("offline-cancel")

    async def materialize():
        return audio_path

    monkeypatch.setattr(provider, "_materialize_audio", materialize)
    await provider.__aenter__()
    await provider.start(RealtimeSessionCreate())
    finishing = asyncio.create_task(provider.finish())
    await asyncio.wait_for(started.wait(), timeout=2)
    finishing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.shield(finishing)

    events_task = asyncio.create_task(_collect_offline_events(provider))
    assert await asyncio.wait_for(events_task, timeout=1) == []
    await provider.__aexit__(None, None, None)


async def _collect_offline_events(provider):
    return [event async for event in provider.events()]


def test_realtime_registry_resolves_builtin_providers():
    from app.config import Settings
    from app.services.asr import (
        create_realtime_provider, list_realtime_providers,
        RealtimeMockProvider, RealtimeHTTPProvider, RealtimeOfflineProvider,
        RealtimeWSProvider,
    )
    providers = list_realtime_providers()
    assert "realtime_mock" in providers
    assert "realtime_http" in providers
    assert "realtime_offline" in providers
    assert "realtime_ws" in providers

    mock = create_realtime_provider(Settings(realtime_asr_provider="realtime_mock"))
    assert isinstance(mock, RealtimeMockProvider)
    http = create_realtime_provider(Settings(
        realtime_asr_provider="realtime_http",
        realtime_asr_base_url="http://x/y",
    ))
    assert isinstance(http, RealtimeHTTPProvider)
    offline = create_realtime_provider(Settings(
        realtime_asr_provider="realtime_offline",
        asr_api_key="x",
    ))
    assert isinstance(offline, RealtimeOfflineProvider)
    ws = create_realtime_provider(Settings(
        realtime_asr_provider="realtime_ws",
        realtime_asr_base_url="ws://x/v1/asr/stream",
    ))
    assert isinstance(ws, RealtimeWSProvider)


def test_unknown_realtime_provider_raises():
    from app.config import Settings
    from app.services.asr import create_realtime_provider
    with pytest.raises(ValueError):
        create_realtime_provider(Settings(realtime_asr_provider="does-not-exist"))
