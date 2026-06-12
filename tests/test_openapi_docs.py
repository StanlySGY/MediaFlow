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
    assert "切页面、断线或稍后查询时找回任务" in top_description
    assert "data.task_id" in top_description
    assert "event: message" in top_description
    assert '"type":"text"' in top_description
    assert "不要等第一条 `type=text` 事件才保存 `task_id`" in top_description
    assert "REALTIME_ASR_PROVIDER=realtime_mock" in top_description
    assert "REALTIME_ASR_PROVIDER=realtime_offline" in top_description
    assert "ASR_PROVIDER=openai_chat_audio" in top_description
    assert "Mock final transcription." in top_description
    assert "POST /asr/ping" in top_description

    file_post = paths["/asr/file"]["post"]
    assert "上传 WAV 文件转文字" in file_post["summary"]
    assert "调用顺序" in file_post["description"]
    assert "events_url" in file_post["description"]
    assert "POST /asr/file` 的响应作为 `task_id` 的可靠来源" in file_post["description"]
    assert "所有事件名统一为 `event: message`" in file_post["description"]
    assert "`data.stream=file`" in file_post["description"]
    assert "页面切走或 SSE 断开后" in file_post["description"]
    assert "文件接口使用 `ASR_PROVIDER`" in file_post["description"]
    assert "文件接口不使用 `REALTIME_ASR_PROVIDER`" in file_post["description"]

    file_events = paths["/asr/file/{task_id}/events"]["get"]
    assert "SSE" in file_events["summary"]
    assert "event: message" in file_events["description"]
    assert "data.type" in file_events["description"]
    assert "日志排查和断线恢复" in file_events["description"]
    assert "不要依赖第一条 `type=text` 才拿 `task_id`" in file_events["description"]

    realtime_session = paths["/asr/realtime/session"]["post"]
    assert "实时录音转文字" in realtime_session["summary"]
    assert "realtime_offline" in realtime_session["description"]
    assert "REALTIME_ASR_PROVIDER=realtime_mock" in realtime_session["description"]
    assert "ASR_PROVIDER=openai_chat_audio" in realtime_session["description"]
    assert "Mock final transcription." in realtime_session["description"]

    realtime_audio = paths["/asr/realtime/{session_id}/audio"]["post"]
    assert "上传 base64 音频 chunk" in realtime_audio["summary"]
    assert "is_final=true" in realtime_audio["description"]

    realtime_events = paths["/asr/realtime/{session_id}/events"]["get"]
    assert "event: message" in realtime_events["description"]
    assert "stream=realtime" in realtime_events["description"]
    assert "source_event" in realtime_events["description"]
    assert "默认 `REALTIME_ASR_PROVIDER=realtime_mock`" in realtime_events["description"]
    assert "`{\"audio\":\"\",\"is_final\":true}`" in realtime_events["description"]
    assert (
        '"stream":"realtime"'
        in realtime_events["responses"]["200"]["content"]["text/event-stream"]["example"]
    )

    audio_schema = schema["components"]["schemas"]["RealtimeAudioChunk"]
    assert "base64" in audio_schema["properties"]["audio"]["description"]

    from app.models.schemas import SegmentEvent

    segment_schema = SegmentEvent.model_json_schema()
    task_id_description = segment_schema["properties"]["task_id"]["description"]
    assert "切页面后找回任务" in task_id_description
    assert "POST /asr/file" in task_id_description

    from app.models.schemas import ASRStreamEvent

    stream_schema = ASRStreamEvent.model_json_schema()
    assert "text" in stream_schema["properties"]["type"]["enum"]
    assert "done" in stream_schema["properties"]["type"]["enum"]
    assert "error" in stream_schema["properties"]["type"]["enum"]
