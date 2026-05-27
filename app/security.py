from __future__ import annotations

from fastapi import Header, HTTPException, Query

from app.config import get_settings


async def require_token(
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
) -> None:
    """Validate access token if any tokens are configured.

    Accepts either an `Authorization: Bearer <token>` header (preferred) or a
    `?token=<token>` query parameter — the latter is needed by EventSource,
    which cannot attach headers.
    """
    settings = get_settings()
    allowed = settings.access_tokens_list
    if not allowed:
        return  # auth disabled

    provided: str | None = None
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value:
            provided = value.strip()
    if provided is None and token:
        provided = token.strip()

    if provided is None or provided not in allowed:
        raise HTTPException(status_code=401, detail="invalid or missing access token")
