from __future__ import annotations

from fastapi import Cookie, Header, HTTPException, Query, Request, Response

from app.config import get_settings

SSE_AUTH_COOKIE = "mediaflow_sse_auth"
SSE_AUTH_COOKIE_MAX_AGE = 3600


def _is_sse_path(path: str) -> bool:
    return path.endswith("/events") or path.endswith("/stream")


async def require_token(
    request: Request,
    response: Response,
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
    sse_cookie: str | None = Cookie(default=None, alias=SSE_AUTH_COOKIE),
) -> None:
    """Validate access token if any tokens are configured.

    Accepts an `Authorization: Bearer <token>` header (preferred). The
    `?token=<token>` compatibility path is restricted to SSE endpoints because
    query credentials can be copied into access logs and browser history.
    Browser EventSource connections may use the short-lived HttpOnly cookie
    issued after a valid authenticated request; the cookie is accepted only on
    SSE endpoints.
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
    if provided is None and token and _is_sse_path(request.url.path):
        provided = token.strip()
    if provided is None and sse_cookie and _is_sse_path(request.url.path):
        provided = sse_cookie.strip()

    if provided is None or provided not in allowed:
        raise HTTPException(status_code=401, detail="invalid or missing access token")

    response.set_cookie(
        SSE_AUTH_COOKIE,
        provided,
        max_age=SSE_AUTH_COOKIE_MAX_AGE,
        httponly=True,
        samesite="strict",
        secure=request.url.scheme == "https",
        path="/",
    )
