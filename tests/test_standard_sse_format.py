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
