from __future__ import annotations

import asyncio
import json

import pytest

from app.config import Settings
from app.models.schemas import (
    RealtimeAudioChunk,
    RealtimeSessionCreate,
    RealtimeSessionStatus,
)
from app.services.realtime_manager import RealtimeManager
from app.services.asr.realtime_base import RealtimeASRError


class _FailingProvider:
    def __init__(self, failing_method: str) -> None:
        self.failing_method = failing_method
        self.exited = 0
        self._events: asyncio.Queue[None] = asyncio.Queue()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        self.exited += 1
        self._events.put_nowait(None)

    def bind_session(self, session_id: str) -> None:
        pass

    async def start(self, config: RealtimeSessionCreate) -> None:
        pass

    async def push_audio(self, chunk: RealtimeAudioChunk) -> None:
        if self.failing_method == "push_audio":
            raise RuntimeError("provider push exploded")

    async def finish(self) -> None:
        if self.failing_method == "finish":
            raise RuntimeError("provider finish exploded")

    async def events(self):
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event


@pytest.fixture
def settings() -> Settings:
    return Settings(
        asr_api_key="x",
        realtime_asr_provider="realtime_mock",
        realtime_max_sessions=5,
        realtime_max_chunk_bytes=1024,
        realtime_session_ttl_seconds=60,
    )


async def test_cancelled_startup_removes_session_and_exits_provider(settings, monkeypatch):
    started = asyncio.Event()
    exited = []

    class _BlockingProvider(_FailingProvider):
        def __init__(self):
            super().__init__("")

        async def start(self, config):
            started.set()
            await asyncio.Event().wait()

        async def __aexit__(self, *exc):
            exited.append(exc[0])
            await super().__aexit__(*exc)

    provider = _BlockingProvider()
    monkeypatch.setattr(
        "app.services.realtime_manager.create_realtime_provider",
        lambda _settings: provider,
    )
    rm = RealtimeManager(settings)
    task = asyncio.create_task(rm.create(RealtimeSessionCreate()))
    await asyncio.wait_for(started.wait(), timeout=2)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert rm.list() == []
    assert provider.exited == 1
    assert exited == [asyncio.CancelledError]


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
    with pytest.raises(RealtimeASRError, match="同时录音已达上限"):
        await rm.create(RealtimeSessionCreate())
    await rm.close(s1.session_id)
    await rm.close(s2.session_id)


async def test_max_sessions_check_and_registration_are_atomic(settings):
    settings = settings.model_copy(update={"realtime_max_sessions": 1})
    rm = RealtimeManager(settings)

    results = await asyncio.gather(
        rm.create(RealtimeSessionCreate()),
        rm.create(RealtimeSessionCreate()),
        return_exceptions=True,
    )
    successes = [result for result in results if not isinstance(result, Exception)]
    failures = [result for result in results if isinstance(result, RealtimeASRError)]

    assert len(successes) == 1
    assert len(failures) == 1
    assert failures[0].code == "session_limit"
    await rm.close(successes[0].session_id)


async def test_session_resource_limit_fails_and_releases_provider(settings):
    settings = settings.model_copy(update={"realtime_max_session_bytes": 4})
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())

    await rm.push_audio(info.session_id, RealtimeAudioChunk(seq=0, audio="AAAA"))
    with pytest.raises(RealtimeASRError) as exc_info:
        await rm.push_audio(info.session_id, RealtimeAudioChunk(seq=1, audio="AAAA"))

    assert exc_info.value.code == "resource_limit"
    current = rm.get(info.session_id)
    assert current is not None
    assert current.status == RealtimeSessionStatus.failed
    assert current.bytes_received == 3
    events = [evt async for evt in rm.stream(info.session_id)]
    assert events[-1].error_code == "resource_limit"
    await rm.close(info.session_id)


async def test_cancelled_push_audio_closes_session_and_releases_provider(settings, monkeypatch):
    started = asyncio.Event()

    class _BlockingProvider(_FailingProvider):
        async def push_audio(self, chunk):
            started.set()
            await asyncio.Event().wait()

    provider = _BlockingProvider("")
    monkeypatch.setattr(
        "app.services.realtime_manager.create_realtime_provider",
        lambda _settings: provider,
    )
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    task = asyncio.create_task(
        rm.push_audio(info.session_id, RealtimeAudioChunk(seq=0, audio="AAAA"))
    )
    await asyncio.wait_for(started.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert rm.get(info.session_id).status == RealtimeSessionStatus.closed
    assert provider.exited == 1


async def test_cancelled_finish_closes_session_and_releases_provider(settings, monkeypatch):
    started = asyncio.Event()

    class _BlockingProvider(_FailingProvider):
        async def finish(self):
            started.set()
            await asyncio.Event().wait()

    provider = _BlockingProvider("")
    monkeypatch.setattr(
        "app.services.realtime_manager.create_realtime_provider",
        lambda _settings: provider,
    )
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    task = asyncio.create_task(rm.finish(info.session_id))
    await asyncio.wait_for(started.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert rm.get(info.session_id).status == RealtimeSessionStatus.closed
    assert provider.exited == 1


async def test_provider_push_error_becomes_terminal_error_and_releases_provider(
    settings, monkeypatch
):
    provider = _FailingProvider("push_audio")
    monkeypatch.setattr(
        "app.services.realtime_manager.create_realtime_provider",
        lambda _settings: provider,
    )
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())

    with pytest.raises(RealtimeASRError, match="provider push exploded") as exc_info:
        await rm.push_audio(info.session_id, RealtimeAudioChunk(seq=0, audio="AAAA"))

    assert exc_info.value.code == "internal_error"
    assert rm.get(info.session_id).status == RealtimeSessionStatus.failed
    events = [evt async for evt in rm.stream(info.session_id)]
    assert events[-1].error_code == "internal_error"
    assert provider.exited == 1
    await rm.close(info.session_id)


async def test_provider_finish_error_becomes_terminal_error_and_releases_provider(
    settings, monkeypatch
):
    provider = _FailingProvider("finish")
    monkeypatch.setattr(
        "app.services.realtime_manager.create_realtime_provider",
        lambda _settings: provider,
    )
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())

    with pytest.raises(RealtimeASRError, match="provider finish exploded") as exc_info:
        await rm.finish(info.session_id)

    assert exc_info.value.code == "internal_error"
    assert rm.get(info.session_id).status == RealtimeSessionStatus.failed
    events = [evt async for evt in rm.stream(info.session_id)]
    assert events[-1].error_code == "internal_error"
    assert provider.exited == 1
    await rm.close(info.session_id)


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


def _read_record(settings, session_id: str) -> dict | None:
    path = settings.output_dir / f"{session_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


async def test_finished_recording_is_archived_to_history(settings, tmp_path):
    """A recording must show up in the same history archive as file tasks —
    otherwise closing the tab loses the transcript entirely."""
    settings = settings.model_copy(update={"output_dir": tmp_path / "out"})
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate(language="zh", model="zh-base"))

    for i in range(3):
        await rm.push_audio(info.session_id, RealtimeAudioChunk(seq=i, audio="AAAA"))
    await rm.finish(info.session_id)
    await asyncio.sleep(0.1)
    await rm.close(info.session_id)

    record = _read_record(settings, info.session_id)
    assert record is not None
    assert record["task_id"] == info.session_id
    assert record["kind"] == "realtime"
    # `done` on the session and `done` in the history list are the same word.
    assert record["status"] == "done"
    assert record["session_status"] == "done"
    # The mock's `done` event carries no text; the last `final` is the record.
    assert record["text"] == "Mock final transcription."
    assert record["language"] == "zh"
    assert record["original_name"].startswith("实时录音 ")
    assert "zh-base" in record["original_name"]
    assert record["segments"] == []
    assert record["chunks_received"] == 3
    assert record["error"] is None
    assert record["created_at"] <= record["updated_at"]
    assert record["duration"] >= 0.0


async def test_closed_session_is_archived_as_cancelled(settings, tmp_path):
    """TTL eviction, DELETE and shutdown all end a session as `closed`, which the
    history list has no word for — it is filed as `cancelled` (stopped on its own
    terms), not `failed` (an upstream error)."""
    settings = settings.model_copy(update={"output_dir": tmp_path / "out"})
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    for i in range(3):
        await rm.push_audio(info.session_id, RealtimeAudioChunk(seq=i, audio="AAAA"))

    assert await rm.close(info.session_id) is True
    # close() archives immediately, then the pump drains the frames finish()
    # queued and rewrites the record with the fullest text it ever saw.
    await asyncio.sleep(0.05)
    record = _read_record(settings, info.session_id)
    assert record is not None
    assert record["session_status"] == "closed"
    assert record["status"] == "cancelled"
    assert record["text"] == "Mock final transcription."


async def test_ttl_eviction_archives_the_session(settings, tmp_path):
    settings = settings.model_copy(
        update={"output_dir": tmp_path / "out", "realtime_session_ttl_seconds": 1}
    )
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    for i in range(3):
        await rm.push_audio(info.session_id, RealtimeAudioChunk(seq=i, audio="AAAA"))
    rm._sessions[info.session_id].info.updated_at -= 5

    async with rm._lock:
        expired = rm._evict_expired_locked()
    await rm._exit_expired(expired)

    assert rm.get(info.session_id) is None
    record = _read_record(settings, info.session_id)
    assert record is not None
    assert record["status"] == "cancelled"


async def test_failed_recording_archives_its_error_code(settings, tmp_path):
    settings = settings.model_copy(
        update={"output_dir": tmp_path / "out", "realtime_max_session_bytes": 4}
    )
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    await rm.push_audio(info.session_id, RealtimeAudioChunk(seq=0, audio="AAAA"))
    with pytest.raises(RealtimeASRError):
        await rm.push_audio(info.session_id, RealtimeAudioChunk(seq=1, audio="AAAA"))
    await asyncio.sleep(0.05)

    record = _read_record(settings, info.session_id)
    assert record is not None
    assert record["status"] == "failed"
    assert record["error_code"] == "resource_limit"
    assert record["retryable"] is False
    assert record["error"]
    await rm.close(info.session_id)


async def test_archive_survives_teardown_without_regression(settings, tmp_path):
    """finish -> pump end -> close -> stop may touch the same session several
    times. The record must keep its transcript and must not be downgraded."""
    settings = settings.model_copy(update={"output_dir": tmp_path / "out"})
    rm = RealtimeManager(settings)
    info = await rm.create(RealtimeSessionCreate())
    for i in range(3):
        await rm.push_audio(info.session_id, RealtimeAudioChunk(seq=i, audio="AAAA"))
    await rm.finish(info.session_id)
    await asyncio.sleep(0.1)

    record = _read_record(settings, info.session_id)
    assert record is not None
    assert record["status"] == "done"
    assert record["text"] == "Mock final transcription."

    # Same manager, then a second manager running the shutdown funnel: the session
    # is already gone from the live map, so neither may rewrite the finished record.
    assert await rm.close(info.session_id) is True
    await rm.stop()
    after = _read_record(settings, info.session_id)
    assert after["status"] == "done"
    assert after["text"] == "Mock final transcription."

    second = RealtimeManager(settings)
    await second.start()
    await second.stop()
    assert _read_record(settings, info.session_id) == after
    assert sorted(x.name for x in settings.output_dir.glob("*.json")) == [f"{info.session_id}.json"]


async def test_session_without_audio_or_text_is_not_archived(settings, tmp_path):
    """Creating a session and walking away is not a recording — archiving it would
    fill the history list with empty rows."""
    settings = settings.model_copy(update={"output_dir": tmp_path / "out"})

    exits: list[str] = []

    class _SilentProvider:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> None:
            exits.append("exit")

        def bind_session(self, session_id: str) -> None:
            pass

        async def start(self, config) -> None:
            pass

        async def push_audio(self, chunk) -> None:
            pass

        async def finish(self) -> None:
            pass

        async def events(self):
            if False:
                yield None

    import app.services.realtime_manager as mod
    original = mod.create_realtime_provider
    mod.create_realtime_provider = lambda _settings: _SilentProvider()
    try:
        rm = RealtimeManager(settings)
        info = await rm.create(RealtimeSessionCreate())
        assert await rm.close(info.session_id) is True
        assert _read_record(settings, info.session_id) is None
        assert exits == ["exit"]
    finally:
        mod.create_realtime_provider = original
