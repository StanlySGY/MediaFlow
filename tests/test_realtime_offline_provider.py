from __future__ import annotations

import base64

from app.config import Settings
from app.models.schemas import RealtimeAudioChunk, RealtimeSessionCreate
from app.services.asr.base import ASRResult
from app.services.asr.realtime_offline import RealtimeOfflineProvider


class _FakeOfflineProvider:
    def __init__(self) -> None:
        self.seen_prefixes: list[bytes] = []
        self.prompts: list[str | None] = []

    async def __aenter__(self) -> "_FakeOfflineProvider":
        return self

    async def __aexit__(self, *exc) -> None:
        pass

    async def transcribe(self, file_path, *, prompt: str | None = None) -> ASRResult:
        self.seen_prefixes.append(file_path.read_bytes()[:4])
        self.prompts.append(prompt)
        return ASRResult(text="你好世界，流式返回。")


async def test_realtime_offline_wraps_pcm_chunks_and_streams_simulated_text(tmp_path):
    fake = _FakeOfflineProvider()
    settings = Settings(
        temp_dir=tmp_path,
        asr_api_key="test-key",
        realtime_asr_provider="realtime_offline",
    )
    provider = RealtimeOfflineProvider(settings, provider_factory=lambda _: fake)
    provider.bind_session("s-offline")

    async with provider:
        await provider.start(
            RealtimeSessionCreate(
                sample_rate=16000,
                format="pcm_s16le",
                channels=1,
                prompt_hints="会议录音",
            )
        )
        await provider.push_audio(
            RealtimeAudioChunk(
                seq=1,
                audio=base64.b64encode(b"\x00\x00" * 800).decode("ascii"),
            )
        )
        await provider.push_audio(
            RealtimeAudioChunk(
                seq=2,
                audio=base64.b64encode(b"\x01\x00" * 800).decode("ascii"),
                is_final=True,
            )
        )

        events = [evt async for evt in provider.events()]

    assert fake.seen_prefixes == [b"RIFF"]
    assert fake.prompts == ["会议录音"]
    assert [evt.type for evt in events][-2:] == ["final", "done"]
    assert any(evt.type == "online" and evt.text for evt in events)
    assert events[-2].text == "你好世界，流式返回。"
    assert events[-2].mode == "simulated_streaming"
    assert events[-1].mode == "simulated_streaming"
