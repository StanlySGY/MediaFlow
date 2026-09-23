from pathlib import Path

import httpx
import pytest
import respx

from app.services.asr_client import ASRClient, ASRError


@pytest.fixture
def wav_file(tmp_path: Path) -> Path:
    p = tmp_path / "seg.wav"
    p.write_bytes(b"RIFFFAKEWAVDATA" * 8)
    return p


@respx.mock
async def test_transcribe_success(wav_file: Path):
    route = respx.post("https://example.test/v1/audio/transcriptions").mock(
        return_value=httpx.Response(200, json={"text": "你好世界", "language": "zh", "duration": 1.2}),
    )
    async with ASRClient("https://example.test/v1", "k", "qwen-asr") as c:
        res = await c.transcribe(wav_file)
    assert route.called
    assert res.text == "你好世界"
    assert res.language == "zh"


@respx.mock
async def test_transcribe_retries_on_5xx(wav_file: Path):
    route = respx.post("https://example.test/v1/audio/transcriptions").mock(
        side_effect=[
            httpx.Response(500, text="boom"),
            httpx.Response(500, text="boom"),
            httpx.Response(200, json={"text": "ok"}),
        ],
    )
    async with ASRClient(
        "https://example.test/v1", "k", "qwen-asr",
        max_retries=3, retry_backoff=1.0,
    ) as c:
        res = await c.transcribe(wav_file)
    assert route.call_count == 3
    assert res.text == "ok"


@respx.mock
async def test_transcribe_no_retry_on_4xx(wav_file: Path):
    route = respx.post("https://example.test/v1/audio/transcriptions").mock(
        return_value=httpx.Response(400, text="bad"),
    )
    async with ASRClient(
        "https://example.test/v1", "k", "qwen-asr",
        max_retries=3, retry_backoff=1.0,
    ) as c:
        with pytest.raises(ASRError):
            await c.transcribe(wav_file)
    assert route.call_count == 1


@respx.mock
async def test_sends_model_and_auth(wav_file: Path):
    captured = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        captured["body"] = request.content
        return httpx.Response(200, json={"text": "ok"})

    respx.post("https://example.test/v1/audio/transcriptions").mock(side_effect=_handler)

    async with ASRClient("https://example.test/v1", "secret-key", "qwen3-asr-flash", language="zh") as c:
        await c.transcribe(wav_file)

    assert captured["auth"] == "Bearer secret-key"
    body = captured["body"]
    assert b'name="model"' in body and b"qwen3-asr-flash" in body
    assert b'name="language"' in body and b"Chinese" in body


@respx.mock
async def test_no_prompt_field_when_hotwords_empty(wav_file: Path):
    captured = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.content
        return httpx.Response(200, json={"text": "ok"})

    respx.post("https://example.test/v1/audio/transcriptions").mock(side_effect=_handler)

    async with ASRClient("https://example.test/v1", "k", "qwen-asr") as c:
        await c.transcribe(wav_file)

    assert b'name="prompt"' not in captured["body"]


@respx.mock
async def test_hotwords_and_hints_merged_into_prompt(wav_file: Path):
    captured = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.content
        return httpx.Response(200, json={"text": "ok"})

    respx.post("https://example.test/v1/audio/transcriptions").mock(side_effect=_handler)

    async with ASRClient(
        "https://example.test/v1", "k", "qwen-asr",
        hotwords=["千问", "ASR", "声学模型"],
        prompt_hints="人工智能技术讨论",
    ) as c:
        await c.transcribe(wav_file, prompt="说话人A正在讲解")

    body = captured["body"]
    assert b'name="prompt"' in body
    # All three sources should appear in the joined prompt.
    assert "人工智能技术讨论".encode() in body
    assert "千问".encode() in body and "ASR".encode() in body
    assert "说话人A正在讲解".encode() in body

