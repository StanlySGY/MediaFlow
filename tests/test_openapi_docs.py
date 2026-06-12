from __future__ import annotations

from pathlib import Path


def test_standard_asr_openapi_docs_are_actionable(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("RUNTIME_CONFIG_PATH", str(tmp_path / "rc.json"))
    monkeypatch.setenv("ACCESS_TOKENS", "")

    from app.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app

    schema = create_app().openapi()
    paths = schema["paths"]

    top_description = schema["info"]["description"]
    assert "重要接口速览" in top_description
    assert "实时录音转文字：上传 base64" in top_description
    assert "上传 WAV 文件转文字：上传文件" in top_description
    assert "POST /asr/realtime/session" in top_description
    assert "POST /asr/file" in top_description

    file_post = paths["/asr/file"]["post"]
    assert "上传 WAV 文件转文字" in file_post["summary"]
    assert "调用顺序" in file_post["description"]
    assert "events_url" in file_post["description"]

    file_events = paths["/asr/file/{task_id}/events"]["get"]
    assert "SSE" in file_events["summary"]
    assert "event: segment" in file_events["description"]

    realtime_session = paths["/asr/realtime/session"]["post"]
    assert "实时录音转文字" in realtime_session["summary"]
    assert "realtime_offline" in realtime_session["description"]

    realtime_audio = paths["/asr/realtime/{session_id}/audio"]["post"]
    assert "上传 base64 音频 chunk" in realtime_audio["summary"]
    assert "is_final=true" in realtime_audio["description"]

    realtime_events = paths["/asr/realtime/{session_id}/events"]["get"]
    assert "online" in realtime_events["description"]
    assert "simulated_streaming" in realtime_events["description"]
    assert (
        "simulated_streaming"
        in realtime_events["responses"]["200"]["content"]["text/event-stream"]["example"]
    )

    audio_schema = schema["components"]["schemas"]["RealtimeAudioChunk"]
    assert "base64" in audio_schema["properties"]["audio"]["description"]
