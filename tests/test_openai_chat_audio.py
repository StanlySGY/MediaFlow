from __future__ import annotations

import base64
import json
from pathlib import Path

import httpx
import pytest
import respx

from app.services.asr import ASRError, OpenAIChatAudioProvider


@pytest.fixture
def wav_file(tmp_path: Path) -> Path:
    p = tmp_path / "seg.wav"
    p.write_bytes(b"RIFFFAKEWAVDATA" * 8)
    return p


def _ok_response(text: str) -> httpx.Response:
    return httpx.Response(200, json={
        "id": "chatcmpl-x",
        "object": "chat.completion",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
    })


@respx.mock
async def test_transcribe_extracts_text_from_choices(wav_file: Path):
    respx.post("https://example.test/v1/chat/completions").mock(
        return_value=_ok_response("Hello world, this is Qwen3-ASR."),
    )
    async with OpenAIChatAudioProvider("https://example.test/v1", "k", "qwen3-asr-flash") as p:
        res = await p.transcribe(wav_file)
    assert res.text == "Hello world, this is Qwen3-ASR."
    assert res.words == []  # this surface does not return word timestamps
    assert res.raw is not None and res.raw["choices"][0]["message"]["content"].startswith("Hello")


@respx.mock
async def test_request_body_has_input_audio_data_uri(wav_file: Path):
    captured = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        captured["auth"] = request.headers.get("authorization")
        captured["ctype"] = request.headers.get("content-type")
        return _ok_response("ok")

    respx.post("https://example.test/v1/chat/completions").mock(side_effect=_handler)

    async with OpenAIChatAudioProvider("https://example.test/v1", "secret", "qwen3-asr-flash") as p:
        await p.transcribe(wav_file)

    body = captured["body"]
    assert body["model"] == "qwen3-asr-flash"
    assert captured["auth"] == "Bearer secret"
    assert captured["ctype"].startswith("application/json")

    user_msg = body["messages"][-1]
    assert user_msg["role"] == "user"
    content = user_msg["content"][0]
    assert content["type"] == "input_audio"
    url = content["input_audio"]["data"]
    assert url.startswith("data:audio/wav;base64,")
    assert body["asr_options"]["enable_itn"] is False

    encoded = url.split(",", 1)[1]
    assert base64.b64decode(encoded) == wav_file.read_bytes()


@respx.mock
async def test_does_not_send_system_message_for_asr_task(wav_file: Path):
    captured = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return _ok_response("ok")

    respx.post("https://example.test/v1/chat/completions").mock(side_effect=_handler)

    async with OpenAIChatAudioProvider(
        "https://example.test/v1", "k", "qwen3-asr-flash",
        language="zh",
        hotwords=["千问", "ASR", "声学模型"],
        prompt_hints="人工智能技术讨论",
    ) as p:
        await p.transcribe(wav_file, prompt="说话人A正在讲解")

    msgs = captured["body"]["messages"]
    assert len(msgs) == 1
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"][0]["type"] == "input_audio"


@respx.mock
async def test_no_system_message_when_no_biasing(wav_file: Path):
    captured = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return _ok_response("ok")

    respx.post("https://example.test/v1/chat/completions").mock(side_effect=_handler)

    # No language, no hotwords, no hints, no per-call prompt
    async with OpenAIChatAudioProvider(
        "https://example.test/v1", "k", "qwen3-asr-flash", language=None,
    ) as p:
        await p.transcribe(wav_file)

    msgs = captured["body"]["messages"]
    assert all(m["role"] != "system" for m in msgs)
    assert len(msgs) == 1 and msgs[0]["role"] == "user"


@respx.mock
async def test_retries_on_5xx_then_succeeds(wav_file: Path):
    route = respx.post("https://example.test/v1/chat/completions").mock(side_effect=[
        httpx.Response(503, text="busy"),
        httpx.Response(503, text="busy"),
        _ok_response("finally"),
    ])
    async with OpenAIChatAudioProvider(
        "https://example.test/v1", "k", "qwen3-asr-flash",
        max_retries=3, retry_backoff=1.0,
    ) as p:
        res = await p.transcribe(wav_file)
    assert route.call_count == 3
    assert res.text == "finally"


@respx.mock
async def test_no_retry_on_4xx(wav_file: Path):
    route = respx.post("https://example.test/v1/chat/completions").mock(
        return_value=httpx.Response(401, text="bad key"),
    )
    async with OpenAIChatAudioProvider(
        "https://example.test/v1", "k", "qwen3-asr-flash",
        max_retries=3, retry_backoff=1.0,
    ) as p:
        with pytest.raises(ASRError, match="401"):
            await p.transcribe(wav_file)
    assert route.call_count == 1


@respx.mock
async def test_empty_choices_raises(wav_file: Path):
    respx.post("https://example.test/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={"choices": []}),
    )
    async with OpenAIChatAudioProvider("https://example.test/v1", "k", "qwen3-asr-flash") as p:
        with pytest.raises(ASRError, match="no choices"):
            await p.transcribe(wav_file)


@respx.mock
async def test_handles_list_content_in_message(wav_file: Path):
    respx.post("https://example.test/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={
            "choices": [{"message": {"role": "assistant", "content": [
                {"type": "text", "text": "你好"},
                {"type": "text", "text": "世界"},
            ]}}],
        }),
    )
    async with OpenAIChatAudioProvider("https://example.test/v1", "k", "qwen3-asr-flash") as p:
        res = await p.transcribe(wav_file)
    assert res.text == "你好世界"


def test_registry_resolves_new_provider():
    from app.config import Settings
    from app.services.asr import create_provider, list_providers
    assert "openai_chat_audio" in list_providers()
    p = create_provider(Settings(asr_api_key="k", asr_provider="openai_chat_audio"))
    assert isinstance(p, OpenAIChatAudioProvider)
