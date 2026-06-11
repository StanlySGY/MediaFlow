"""Realtime ASR provider against a standard downstream HTTP+SSE service.

Downstream protocol (each ASR vendor must conform to this):

    POST   {base_url}/session           → {"session_id": ...}
    POST   {base_url}/session/{id}/audio   JSON body RealtimeAudioChunk
    GET    {base_url}/session/{id}/events  SSE: event=online|final|error|done
    POST   {base_url}/session/{id}/end

If a downstream model only speaks WebSocket / non-standard protocols, wrap it
in a small shim that exposes the surface above, then point this provider at
the shim.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

import httpx

from app.models.schemas import RealtimeASREvent, RealtimeAudioChunk, RealtimeSessionCreate
from app.services.asr.realtime_base import RealtimeASRError

log = logging.getLogger(__name__)


class RealtimeHTTPProvider:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str = "",
        model: str = "",
        timeout: float = 60.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._model = model
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None
        self._down_session_id: str | None = None
        self._session_id = ""
        self._queue: asyncio.Queue[RealtimeASREvent | None] = asyncio.Queue()
        self._reader_task: asyncio.Task | None = None
        self._finished = False

    async def __aenter__(self) -> "RealtimeHTTPProvider":
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(self._timeout),
            headers=headers,
        )
        return self

    async def __aexit__(self, *exc) -> None:
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        if not self._finished:
            self._queue.put_nowait(None)

    def bind_session(self, session_id: str) -> None:
        self._session_id = session_id

    async def start(self, config: RealtimeSessionCreate) -> None:
        if self._client is None:
            raise RuntimeError("provider must be used as async context manager")
        body = config.model_dump()
        if not body.get("model") and self._model:
            body["model"] = self._model
        resp = await self._client.post("/session", json=body)
        if resp.status_code >= 400:
            raise RealtimeASRError(f"downstream /session failed {resp.status_code}: {resp.text[:200]}")
        data = resp.json()
        self._down_session_id = data.get("session_id") or data.get("id")
        if not self._down_session_id:
            raise RealtimeASRError(f"downstream returned no session_id: {data}")
        self._reader_task = asyncio.create_task(self._read_events())

    async def push_audio(self, chunk: RealtimeAudioChunk) -> None:
        if self._client is None or not self._down_session_id:
            raise RealtimeASRError("session not started")
        resp = await self._client.post(
            f"/session/{self._down_session_id}/audio",
            json=chunk.model_dump(),
        )
        if resp.status_code >= 400:
            raise RealtimeASRError(f"downstream /audio failed {resp.status_code}: {resp.text[:200]}")

    async def finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        if self._client is None or not self._down_session_id:
            return
        try:
            await self._client.post(f"/session/{self._down_session_id}/end")
        except Exception:  # noqa: BLE001
            log.warning("downstream /end call failed", exc_info=True)

    async def _read_events(self) -> None:
        assert self._client is not None and self._down_session_id is not None
        try:
            async with self._client.stream("GET", f"/session/{self._down_session_id}/events") as resp:
                if resp.status_code >= 400:
                    raise RealtimeASRError(f"downstream /events failed {resp.status_code}")
                evt_type = "message"
                async for raw in resp.aiter_lines():
                    if not raw:
                        continue
                    if raw.startswith("event:"):
                        evt_type = raw[6:].strip() or "message"
                        continue
                    if raw.startswith("data:"):
                        try:
                            payload = json.loads(raw[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        self._queue.put_nowait(RealtimeASREvent(
                            type=evt_type,
                            session_id=self._session_id,
                            seq=payload.get("seq"),
                            text=payload.get("text", ""),
                            is_final=bool(payload.get("is_final")),
                            elapsed_ms=float(payload.get("elapsed_ms", 0.0) or 0.0),
                            mode=payload.get("mode"),
                            error=payload.get("error"),
                            raw=payload,
                        ))
                        if evt_type in {"done", "error"}:
                            break
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self._queue.put_nowait(RealtimeASREvent(
                type="error", session_id=self._session_id,
                text="", error=str(e),
            ))
        finally:
            self._queue.put_nowait(None)

    async def events(self) -> AsyncIterator[RealtimeASREvent]:
        while True:
            evt = await self._queue.get()
            if evt is None:
                return
            yield evt
