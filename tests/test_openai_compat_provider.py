from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx

from app.services.asr.openai_compat import OpenAICompatProvider

URL = "https://example.test/v1/audio/transcriptions"


@pytest.fixture
def wav_file(tmp_path: Path) -> Path:
    p = tmp_path / "seg.wav"
    p.write_bytes(b"RIFFFAKEWAVDATA" * 8)
    return p


def _provider(**kw) -> OpenAICompatProvider:
    return OpenAICompatProvider("https://example.test/v1", "k", "qwen3-asr", **kw)


@respx.mock
async def test_word_timestamps_carry_speaker_when_upstream_labels_words(wav_file: Path):
    respx.post(URL).mock(return_value=httpx.Response(200, json={
        "text": "你好 世界",
        "language": "zh",
        "duration": 2.0,
        "words": [
            {"word": "你好", "start": 0.0, "end": 1.0, "speaker": "SPEAKER_00"},
            {"word": "世界", "start": 1.0, "end": 2.0, "speaker_id": 1},
        ],
    }))
    async with _provider() as p:
        res = await p.transcribe(wav_file)
    assert [(w.word, w.speaker) for w in res.words] == [("你好", "SPEAKER_00"), ("世界", "1")]


@respx.mock
async def test_segment_timestamps_are_parsed_when_words_are_absent(wav_file: Path):
    # The request asks for segment granularity, and diarizing upstreams put the
    # speaker label on segments. Dropping this block paid for the timestamps in
    # upstream bandwidth and returned no speaker labels to the merger.
    respx.post(URL).mock(return_value=httpx.Response(200, json={
        "text": "甲说了一句 乙说了一句",
        "language": "zh",
        "duration": 6.0,
        "segments": [
            {"text": "甲说了一句", "start": 0.0, "end": 3.0, "speaker": "SPEAKER_00"},
            {"text": "乙说了一句", "start": 3.0, "end": 6.0, "speaker_id": "SPEAKER_01"},
        ],
    }))
    async with _provider() as p:
        res = await p.transcribe(wav_file)
    assert [(w.word, w.start, w.end, w.speaker) for w in res.words] == [
        ("甲说了一句", 0.0, 3.0, "SPEAKER_00"),
        ("乙说了一句", 3.0, 6.0, "SPEAKER_01"),
    ]


@respx.mock
async def test_text_only_when_upstream_returns_only_segments(wav_file: Path):
    respx.post(URL).mock(return_value=httpx.Response(200, json={
        "segments": [{"text": "只有分片", "start": 0.0, "end": 1.0}],
    }))
    async with _provider() as p:
        res = await p.transcribe(wav_file)
    assert res.text == "只有分片"


@respx.mock
async def test_word_stream_is_not_replaced_by_coarser_segments(wav_file: Path):
    respx.post(URL).mock(return_value=httpx.Response(200, json={
        "text": "hello world",
        "words": [{"word": "hello", "start": 0.0, "end": 0.5}, {"word": "world", "start": 0.5, "end": 1.0}],
        "segments": [{"text": "hello world", "start": 0.0, "end": 1.0, "speaker": "S0"}],
    }))
    async with _provider() as p:
        res = await p.transcribe(wav_file)
    assert [w.word for w in res.words] == ["hello", "world"]


@respx.mock
async def test_plain_json_response_still_works(wav_file: Path):
    respx.post(URL).mock(return_value=httpx.Response(200, json={"text": "你好世界", "language": "zh"}))
    async with _provider(request_timestamps=False) as p:
        res = await p.transcribe(wav_file)
    assert res.text == "你好世界"
    assert res.words == []
