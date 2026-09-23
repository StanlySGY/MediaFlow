"""Discover model ids advertised by an OpenAI-compatible upstream."""
from __future__ import annotations

import httpx

_TIMEOUT = httpx.Timeout(8.0, connect=3.0)


def _ids(payload: object) -> list[str]:
    if not isinstance(payload, dict):
        return []
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    out: list[str] = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip():
            out.append(item["id"].strip())
    return out


def _name_from_info(payload: object) -> list[str]:
    """Qwen3-ASR's own service reports the loaded model at /v1/info instead of
    serving OpenAI's /models. The directory name of model_path is the model id."""
    if not isinstance(payload, dict):
        return []
    path = payload.get("model_path")
    if not isinstance(path, str) or not path.strip():
        return []
    name = path.rstrip("/").rsplit("/", 1)[-1].strip()
    return [name] if name else []


async def list_models(base_url: str, api_key: str = "") -> list[str]:
    """Return the model ids an upstream advertises.

    Tries OpenAI's ``{base_url}/models`` first; when that is missing (the
    bundled Qwen3-ASR service answers 404 there) it falls back to
    ``{base_url}/info``. Raises ``httpx.HTTPError`` on transport failure and
    ``httpx.HTTPStatusError`` when every probed endpoint errors.
    """
    root = base_url.strip().rstrip("/")
    if not root:
        raise ValueError("base_url is empty")
    # Realtime config stores the full websocket path (…/v1/asr/stream); the model
    # list lives on the OpenAI-compatible root, one level above that path, and
    # is only reachable over HTTP.
    parsed = httpx.URL(root)
    if parsed.scheme in ("ws", "wss"):
        parsed = parsed.copy_with(scheme="https" if parsed.scheme == "wss" else "http")
        root = str(parsed).rstrip("/")
    if root.endswith("/asr/stream"):
        root = root[: -len("/asr/stream")]
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=headers) as client:
        resp = await client.get(f"{root}/models")
        if resp.status_code == 404:
            info = await client.get(f"{root}/info")
            info.raise_for_status()
            return _name_from_info(info.json())
        resp.raise_for_status()
        return _ids(resp.json())
