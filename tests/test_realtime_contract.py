from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.models.schemas import ASRDelta, ASRStreamEvent, RealtimeASREvent


def test_done_and_error_have_null_delta():
    for event_type in ("done", "error"):
        event = ASRStreamEvent(
            type=event_type,
            stream="realtime",
            id="session-1",
            is_final=(event_type == "done"),
            delta=None,
        )
        assert event.delta is None


def test_contract_rejects_non_null_terminal_delta():
    with pytest.raises(ValidationError, match="delta=null"):
        ASRStreamEvent(
            type="done",
            stream="realtime",
            id="session-1",
            is_final=True,
            delta=ASRDelta(text="unexpected"),
        )


def test_contract_rejects_non_terminal_done():
    with pytest.raises(ValidationError, match="is_final=true"):
        ASRStreamEvent(
            type="done",
            stream="realtime",
            id="session-1",
            is_final=False,
            delta=None,
        )


def test_contract_requires_delta_for_text_events():
    with pytest.raises(ValidationError, match="must have a delta"):
        ASRStreamEvent(
            type="text",
            stream="realtime",
            id="session-1",
            delta=None,
        )


def test_contract_rejects_negative_sequence():
    with pytest.raises(ValidationError, match="seq must be >= 0"):
        ASRStreamEvent(
            type="text",
            stream="realtime",
            id="session-1",
            delta=ASRDelta(text="x"),
            seq=-1,
        )


def test_realtime_mapper_emits_public_contract_for_terminal_events():
    from app.api.routes import _standard_realtime_sse_message

    done = _standard_realtime_sse_message(
        RealtimeASREvent(
            type="done",
            session_id="session-1",
            text="ignored",
            is_final=True,
            seq=9,
        )
    )
    done_payload = json.loads(done["data"])
    assert done_payload["type"] == "done"
    assert done_payload["delta"] is None
    assert done_payload["is_final"] is True

    error = _standard_realtime_sse_message(
        RealtimeASREvent(
            type="error",
            session_id="session-1",
            text="must not leak",
            error="upstream failed",
            seq=10,
        )
    )
    error_payload = json.loads(error["data"])
    assert error_payload["type"] == "error"
    assert error_payload["delta"] is None
    assert error_payload["error"] == "upstream failed"


def test_realtime_mapper_produces_delta_for_text_event():
    from app.api.routes import _standard_realtime_sse_message

    message = _standard_realtime_sse_message(
        RealtimeASREvent(
            type="final",
            session_id="session-1",
            text="今天天气",
            is_final=True,
            seq=3,
        ),
        previous_text="今天",
    )
    payload = json.loads(message["data"])
    assert payload["type"] == "text"
    assert payload["delta"] == {"start": 2, "remove": 0, "text": "天气"}
    assert payload["text"] == ""
    assert payload["seq"] == 3
