from __future__ import annotations

import asyncio

import pytest

from app.config import Settings
from app.models.schemas import (
    RealtimeAudioChunk,
    RealtimeSessionCreate,
    RealtimeSessionStatus,
)
from app.services.realtime_manager import RealtimeManager


@pytest.fixture
def settings() -> Settings:
    return Settings(
        asr_api_key="x",
        realtime_asr_provider="realtime_mock",
        realtime_max_sessions=5,
        realtime_max_chunk_bytes=1024,
        realtime_session_ttl_seconds=60,
    )


async def test_create_returns_session_with_urls(settings):
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate(language="zh"))
    assert info.session_id
    assert info.status in {RealtimeSessionStatus.active, RealtimeSessionStatus.starting}
    assert info.events_url.endswith("/events")
    assert info.audio_url.endswith("/audio")
    assert info.end_url.endswith("/end")
    await rm.close(info.session_id)


async def test_push_audio_then_finish_emits_online_final_done(settings):
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    sid = info.session_id

    # use small valid base64 (~10 bytes decoded)
    valid_b64 = "AAAAAAAAAAA="
    for i in range(6):
        await rm.push_audio(sid, RealtimeAudioChunk(seq=i, audio=valid_b64))
    await rm.finish(sid)

    types = []
    async for evt in rm.stream(sid):
        types.append(evt.type)
    assert "online" in types
    assert types[-2] == "final"
    assert types[-1] == "done"

    final_info = rm.get(sid)
    assert final_info.status == RealtimeSessionStatus.done
    assert final_info.chunks_received == 6
    assert final_info.bytes_received > 0
    await rm.close(sid)


async def test_is_final_chunk_triggers_completion(settings):
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    sid = info.session_id
    await rm.push_audio(sid, RealtimeAudioChunk(seq=0, audio="AAAA"))
    await rm.push_audio(sid, RealtimeAudioChunk(seq=1, audio="", is_final=True))

    types = [evt.type async for evt in rm.stream(sid)]
    assert types[-1] == "done"
    await rm.close(sid)


async def test_empty_chunk_without_is_final_rejected(settings):
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    sid = info.session_id
    with pytest.raises(ValueError, match="empty audio"):
        await rm.push_audio(sid, RealtimeAudioChunk(seq=0, audio=""))
    await rm.close(sid)


async def test_invalid_base64_rejected(settings):
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    sid = info.session_id
    with pytest.raises(ValueError, match="invalid base64"):
        await rm.push_audio(sid, RealtimeAudioChunk(seq=0, audio="!!!not base64!!!"))
    await rm.close(sid)


async def test_chunk_size_limit_enforced(settings):
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    sid = info.session_id

    import base64
    big = base64.b64encode(b"\x00" * 2048).decode()  # 2 KiB > 1 KiB limit
    with pytest.raises(ValueError, match="exceeds realtime_max_chunk_bytes"):
        await rm.push_audio(sid, RealtimeAudioChunk(seq=0, audio=big))
    await rm.close(sid)


async def test_session_not_found_raises_keyerror(settings):
    rm = RealtimeManager(settings)
    with pytest.raises(KeyError):
        await rm.push_audio("does-not-exist", RealtimeAudioChunk(seq=0, audio="AAAA"))
    with pytest.raises(KeyError):
        await rm.finish("does-not-exist")


async def test_multiple_subscribers_each_get_all_events(settings):
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    sid = info.session_id

    out_a: list[str] = []
    out_b: list[str] = []

    async def consume(out):
        async for evt in rm.stream(sid):
            out.append(evt.type)

    a = asyncio.create_task(consume(out_a))
    b = asyncio.create_task(consume(out_b))
    await asyncio.sleep(0)

    for i in range(3):
        await rm.push_audio(sid, RealtimeAudioChunk(seq=i, audio="AAAA"))
    await rm.finish(sid)
    await asyncio.gather(a, b)

    assert out_a == out_b
    assert out_a[-1] == "done"
    await rm.close(sid)


async def test_close_then_push_returns_keyerror(settings):
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    sid = info.session_id
    assert await rm.close(sid) is True
    with pytest.raises(KeyError):
        await rm.push_audio(sid, RealtimeAudioChunk(seq=0, audio="AAAA"))


async def test_max_sessions_enforced(settings):
    settings = settings.model_copy(update={"realtime_max_sessions": 2})
    rm = RealtimeManager(settings)
    s1 = await rm.create(RealtimeSessionCreate())
    s2 = await rm.create(RealtimeSessionCreate())
    from app.services.asr.realtime_base import RealtimeASRError
    with pytest.raises(RealtimeASRError, match="max realtime sessions"):
        await rm.create(RealtimeSessionCreate())
    await rm.close(s1.session_id)
    await rm.close(s2.session_id)


async def test_finished_sessions_do_not_count_toward_cap(settings):
    """A `done` session lingers for SSE replay but must not starve new recordings
    (regression: 8 finished sessions blocked the 9th create until TTL eviction)."""
    settings = settings.model_copy(update={"realtime_max_sessions": 2})
    rm = RealtimeManager(settings)
    s1 = await rm.create(RealtimeSessionCreate())
    s2 = await rm.create(RealtimeSessionCreate())
    # Drive both to a terminal state without removing them from the map.
    await rm.push_audio(s1.session_id, RealtimeAudioChunk(seq=0, audio="AAAA"))
    await rm.finish(s1.session_id)
    await rm.push_audio(s2.session_id, RealtimeAudioChunk(seq=0, audio="AAAA"))
    await rm.finish(s2.session_id)
    await asyncio.sleep(0.1)
    assert rm.get(s1.session_id).status == RealtimeSessionStatus.done
    assert rm.get(s2.session_id).status == RealtimeSessionStatus.done
    # Cap only counts live sessions, so create #3 succeeds while replays linger.
    s3 = await rm.create(RealtimeSessionCreate())
    assert s3.session_id
    for sid in (s1.session_id, s2.session_id, s3.session_id):
        await rm.close(sid)


async def test_late_subscriber_replays_history(settings):
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    sid = info.session_id

    for i in range(4):
        await rm.push_audio(sid, RealtimeAudioChunk(seq=i, audio="AAAA"))
    await rm.finish(sid)
    # Let the pump drain.
    await asyncio.sleep(0.05)

    types = [evt.type async for evt in rm.stream(sid)]
    assert "online" in types
    assert types[-1] == "done"
    await rm.close(sid)
