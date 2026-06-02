from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


class FFmpegError(RuntimeError):
    pass


@dataclass(frozen=True)
class SilenceRange:
    start: float
    end: float

    @property
    def mid(self) -> float:
        return (self.start + self.end) / 2


async def _run(cmd: list[str], *, capture_stderr: bool = True) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE if capture_stderr else None,
    )
    stdout_b, stderr_b = await proc.communicate()
    return (
        proc.returncode or 0,
        stdout_b.decode("utf-8", "replace"),
        (stderr_b or b"").decode("utf-8", "replace"),
    )


async def probe_duration(path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    rc, out, err = await _run(cmd)
    if rc != 0:
        raise FFmpegError(f"ffprobe failed: {err.strip()}")
    return float(json.loads(out)["format"]["duration"])


async def normalize_to_wav(src: Path, dst: Path) -> None:
    """Convert any input → 16kHz mono pcm_s16le wav."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(dst),
    ]
    rc, _, err = await _run(cmd)
    if rc != 0:
        raise FFmpegError(f"ffmpeg convert failed: {err.strip()[-400:]}")


_SILENCE_RE = re.compile(r"silence_(start|end):\s*(-?\d+(?:\.\d+)?)")


async def detect_silence(
    path: Path, noise_db: float, min_duration: float
) -> list[SilenceRange]:
    """Return silence ranges. Uses ffmpeg silencedetect filter."""
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-af",
        f"silencedetect=noise={noise_db}dB:d={min_duration}",
        "-f",
        "null",
        "-",
    ]
    rc, _, err = await _run(cmd)
    if rc != 0:
        raise FFmpegError(f"silencedetect failed: {err.strip()[-400:]}")

    starts: list[float] = []
    ends: list[float] = []
    for m in _SILENCE_RE.finditer(err):
        (starts if m.group(1) == "start" else ends).append(float(m.group(2)))
    # Pair start/end greedily; ignore unmatched.
    return [SilenceRange(s, e) for s, e in zip(starts, ends) if e > s]


async def slice_segment(src: Path, dst: Path, start: float, end: float) -> None:
    """Cut a precise segment (re-encode for sample-accurate cut)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    duration = max(end - start, 0.01)
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{start:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(dst),
    ]
    rc, _, err = await _run(cmd)
    if rc != 0:
        raise FFmpegError(f"slice failed: {err.strip()[-400:]}")


def _concat_quote(path: Path) -> str:
    # concat list lines are `file '<path>'`; a single quote in the path must be
    # written as '\'' to survive ffmpeg's tokenizer. Absolute paths + -safe 0.
    return str(path.resolve()).replace("'", "'\\''")


async def concat_media(parts: list[Path], dst: Path) -> None:
    """Concatenate same-codec audio/video files in order, no re-encode (stream copy).

    Inputs must share one container/codec/sample rate/channel layout (the caller
    guarantees this); ffmpeg fails loudly otherwise.
    """
    if not parts:
        raise FFmpegError("concat needs at least one input")
    dst.parent.mkdir(parents=True, exist_ok=True)
    list_file = dst.with_name(dst.name + ".concat.txt")
    list_file.write_text(
        "".join(f"file '{_concat_quote(p)}'\n" for p in parts),
        encoding="utf-8",
    )
    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_file),
            "-c",
            "copy",
            str(dst),
        ]
        rc, _, err = await _run(cmd)
        if rc != 0:
            raise FFmpegError(f"concat failed: {err.strip()[-400:]}")
    finally:
        list_file.unlink(missing_ok=True)
