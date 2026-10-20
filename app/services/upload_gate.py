"""Upload admission control: a concurrency cap plus a free-disk floor.

`max_upload_bytes` bounds one file. Nothing bounded *how many* files could be in
flight, and nothing checked whether the volume had room for them — several 2 GiB
uploads from a few clients could fill the disk the service also writes task
output to, and the failure then showed up as a corrupt write somewhere else
rather than as a rejected upload.

This runs as HTTP middleware rather than inside each handler: the upload
handlers are also called directly by tests and scripts, and threading a
`Request` through every signature to reach a semaphore is a lot of plumbing for
a rule that is purely about the wire.
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from app.services.metrics import request_metrics

log = logging.getLogger(__name__)

# Below this much free space the service stops accepting uploads. The source
# file is normalized to WAV and then split, so one upload can need several times
# its own size on disk before it is cleaned up.
MIN_FREE_BYTES = 512 * 1024 * 1024

# Exact paths that accept a file body. Matched on the raw scope path, so a
# renamed or new upload endpoint has to be added here deliberately.
UPLOAD_PATHS = frozenset(
    {
        "/asr/file",
        "/asr/task",
        "/asr/transcribe-stream",
        "/media/concat",
    }
)


class UploadGate:
    """Counts in-flight uploads and refuses new ones past the cap."""

    def __init__(self, *, max_concurrent: int, min_free_bytes: int = MIN_FREE_BYTES) -> None:
        self.max_concurrent = max(1, max_concurrent)
        self.min_free_bytes = min_free_bytes
        self._active = 0

    @property
    def active(self) -> int:
        return self._active

    def try_acquire(self) -> bool:
        if self._active >= self.max_concurrent:
            return False
        self._active += 1
        return True

    def release(self) -> None:
        if self._active > 0:
            self._active -= 1

    def check_disk(self, directory: Path, declared_bytes: int) -> tuple[int, str] | None:
        """Return (status, message) when the upload must be refused."""
        try:
            free = shutil.disk_usage(directory).free
        except OSError:
            # Cannot measure it (odd mount, permissions): do not block uploads
            # on a metric that is unavailable.
            return None
        needed = self.min_free_bytes + declared_bytes
        if free < needed:
            log.warning(
                "rejecting upload: %.1f MiB free, %.1f MiB required",
                free / 1024 / 1024,
                needed / 1024 / 1024,
            )
            return (
                507,
                f"磁盘剩余空间不足（可用 {free // 1024 // 1024} MiB），"
                "请先清理历史记录或联系管理员",
            )
        return None


class UploadAdmissionMiddleware:
    """Refuse an upload before its body is read, not after.

    The rejection is a normal JSON error with the service's `code`/`message`
    shape, so the console renders it like any other failure instead of showing
    a bare 429.
    """

    def __init__(self, app, gate: UploadGate, temp_dir: Path) -> None:
        self.app = app
        self.gate = gate
        self.temp_dir = temp_dir

    @staticmethod
    def _is_upload(scope) -> bool:
        if scope.get("type") != "http" or scope.get("method") != "POST":
            return False
        if scope.get("path") not in UPLOAD_PATHS:
            return False
        for name, value in scope.get("headers", []):
            if name.lower() == b"content-type" and value.lower().startswith(
                b"multipart/form-data"
            ):
                return True
        return False

    async def __call__(self, scope, receive, send):
        if not self._is_upload(scope):
            await self.app(scope, receive, send)
            return

        if not self.gate.try_acquire():
            await self._reject(
                scope,
                send,
                429,
                f"同时上传的文件已达上限（{self.gate.max_concurrent} 个），请等前一个上传完成后再试",
                "upload_limit",
            )
            return

        try:
            declared = 0
            for name, value in scope.get("headers", []):
                if name.lower() == b"content-length":
                    try:
                        declared = max(0, int(value))
                    except ValueError:
                        declared = 0
                    break
            refused = self.gate.check_disk(self.temp_dir, declared)
            if refused is not None:
                status, message = refused
                await self._reject(scope, send, status, message, "insufficient_storage")
                return
            await self.app(scope, receive, send)
        finally:
            self.gate.release()

    async def _reject(self, scope, send, status: int, message: str, code: str) -> None:
        # The request observer sits inside this middleware, so a refusal never
        # reaches it. Record it here or rejected uploads would be invisible in
        # /metrics — precisely the case an operator needs to see.
        body = json.dumps(
            {"detail": {"code": code, "message": message, "hint": None, "retryable": False}},
            ensure_ascii=False,
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
        request_metrics.observe(scope.get("method", "POST"), scope.get("path", "upload"), status, 0.0)
