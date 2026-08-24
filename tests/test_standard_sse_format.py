from __future__ import annotations

import json

from app.models.schemas import RealtimeASREvent, SegmentEvent, TaskInfo, TaskStatus


def _decode_sse_payload(message: dict) -> dict:
    assert message["event"] == "message"
    return json.loads(message["data"])


def test_realtime_events_convert_to_standard_sse_messages():
    from app.api.routes import _standard_realtime_sse_message

    partial = _decode_sse_payload(
        _standard_realtime_sse_message(
            RealtimeASREvent(
                type="online",
                session_id="sess-1",
                seq=7,
                text="实时中间文本",
                is_final=False,
                elapsed_ms=20.0,
                mode="simulated_streaming",
            )
        )
    )
    assert partial == {
        "type": "text",
        "stream": "realtime",
        "id": "sess-1",
        "text": "实时中间文本",
        "delta": "实时中间文本",
        "is_final": False,
        "seq": 7,
        "session_id": "sess-1",
        "task_id": None,
        "segment_id": None,
        "start": None,
        "end": None,
        "elapsed_ms": 20.0,
        "status": None,
        "progress": None,
        "error": None,
        "source_event": "online",
    }

    done = _decode_sse_payload(
        _standard_realtime_sse_message(
            RealtimeASREvent(type="done", session_id="sess-1", is_final=True)
        )
    )
    assert done["type"] == "done"
    assert done["stream"] == "realtime"
    assert done["id"] == "sess-1"
    assert done["is_final"] is True


def test_file_events_convert_to_same_standard_sse_message_shape():
    from app.api.routes import (
        _standard_file_done_sse_message,
        _standard_file_segment_sse_message,
    )

    text = _decode_sse_payload(
        _standard_file_segment_sse_message(
            SegmentEvent(
                task_id="task-1",
                segment_id=3,
                start=1.0,
                end=2.5,
                text="文件分片文本",
                is_final=True,
                elapsed_ms=12.0,
            )
        )
    )
    assert text == {
        "type": "text",
        "stream": "file",
        "id": "task-1",
        "text": "文件分片文本",
        "delta": "文件分片文本",
        "is_final": True,
        "seq": 3,
        "session_id": None,
        "task_id": "task-1",
        "segment_id": 3,
        "start": 1.0,
        "end": 2.5,
        "elapsed_ms": 12.0,
        "status": None,
        "progress": None,
        "error": None,
        "source_event": "segment",
    }

    done = _decode_sse_payload(
        _standard_file_done_sse_message(
            TaskInfo(
                task_id="task-1",
                status=TaskStatus.done,
                progress=1.0,
                total_segments=3,
                finished_segments=3,
            )
        )
    )
    assert done["type"] == "done"
    assert done["stream"] == "file"
    assert done["id"] == "task-1"
    assert done["task_id"] == "task-1"
    assert done["status"] == "done"
    assert done["progress"] == 1.0


def test_realtime_delta_is_suffix_of_growing_text():
    from app.api.routes import _standard_realtime_sse_message

    first = _decode_sse_payload(
        _standard_realtime_sse_message(
            RealtimeASREvent(type="online", session_id="s", text="今天"),
            previous_text="",
        )
    )
    assert first["text"] == "今天"
    assert first["delta"] == "今天"

    second = _decode_sse_payload(
        _standard_realtime_sse_message(
            RealtimeASREvent(type="online", session_id="s", text="今天天气"),
            previous_text=first["text"],
        )
    )
    assert second["text"] == "今天天气"
    assert second["delta"] == "天气"


def test_realtime_delta_falls_back_to_full_text_when_not_a_simple_extension():
    from app.api.routes import _standard_realtime_sse_message

    # Upstream revised/shortened its output instead of just appending to it;
    # delta must fall back to the full text so nothing is silently lost.
    revised = _decode_sse_payload(
        _standard_realtime_sse_message(
            RealtimeASREvent(type="online", session_id="s", text="今天天气很好"),
            previous_text="今天天气不错",
        )
    )
    assert revised["text"] == "今天天气很好"
    assert revised["delta"] == "今天天气很好"


def test_realtime_done_and_error_events_have_empty_delta():
    from app.api.routes import _standard_realtime_sse_message

    done = _decode_sse_payload(
        _standard_realtime_sse_message(
            RealtimeASREvent(type="done", session_id="s", is_final=True),
            previous_text="今天天气不错",
        )
    )
    assert done["delta"] == ""

    error = _decode_sse_payload(
        _standard_realtime_sse_message(
            RealtimeASREvent(type="error", session_id="s", error="boom"),
            previous_text="今天天气不错",
        )
    )
    assert error["delta"] == ""
