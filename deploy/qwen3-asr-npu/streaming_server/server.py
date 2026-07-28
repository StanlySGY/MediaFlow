"""Qwen3-ASR 真正流式识别服务。

包装 qwen-asr 库的 ``streaming_transcribe()`` 增量流式 API（vLLM 后端），
对外暴露与 MediaFlow ``RealtimeHTTPProvider`` 兼容的 HTTP+SSE 协议：

    POST   /session              → {"session_id": ...}
    POST   /session/{id}/audio   (JSON RealtimeAudioChunk)
    GET    /session/{id}/events  (SSE: event=online|final|error|done)
    POST   /session/{id}/end
    GET    /health               → {"status": "ok", "model_loaded": true}

与 vLLM ``vllm serve`` 的区别：后者只能接收完整音频后返回结果（MediaFlow 端
用 realtime_offline “录完再识别”模拟流式）；本服务是**真正的边说边出字**——
音频 chunk 到达即解码、增量识别、立即通过 SSE 推送部分结果。

音频链路：浏览器 MediaRecorder 产出的是 webm/ogg(opus) 容器**增量流**，单个
chunk 无法独立解码（只有第一个 chunk 带容器头）。因此每个 session 维护一个
常驻 ffmpeg 子进程，把不断到达的原始字节写入 ffmpeg stdin，从 stdout 读取
16kHz 单声道 s16le PCM，再喂给 qwen-asr 的流式接口。对于直接上传 pcm_s16le
的场景，则按声明的采样率/声道数让 ffmpeg 重采样到 16kHz 单声道。

依赖：
  pip install "qwen-asr[vllm]" fastapi uvicorn numpy
  系统需安装 ffmpeg
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("qwen3-asr-streaming")

# ---------------------------------------------------------------------------
# 配置（环境变量）
# ---------------------------------------------------------------------------
MODEL_DIR = os.environ.get("MODEL_DIR", "/data/models/Qwen3-ASR-1.7B")
GPU_MEMORY_UTILIZATION = float(os.environ.get("GPU_MEMORY_UTILIZATION", "0.9"))
MAX_NEW_TOKENS = int(os.environ.get("MAX_NEW_TOKENS", "4096"))
# qwen-asr 流式内部按此秒数切块解码；越小越“即时”，但推理调用更频繁。
CHUNK_SIZE_SEC = float(os.environ.get("CHUNK_SIZE_SEC", "2.0"))
# 从 ffmpeg 读取 PCM 的块大小（秒）。16kHz*2字节 = 32000 B/s。
READ_BLOCK_SEC = float(os.environ.get("READ_BLOCK_SEC", "0.5"))
SAMPLE_RATE = 16000  # qwen-asr 流式固定要求 16kHz 单声道
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
SESSION_TTL_SECONDS = float(os.environ.get("SESSION_TTL_SECONDS", "600"))

READ_BLOCK_BYTES = max(2, int(SAMPLE_RATE * READ_BLOCK_SEC) * 2)

# ---------------------------------------------------------------------------
# 模型（全局单例，惰性/启动时加载）
# ---------------------------------------------------------------------------
_model: Any = None
_model_lock = asyncio.Lock()  # 串行化对同一 vLLM 实例的推理调用（单卡实时）


def load_model() -> Any:
    """加载 Qwen3ASRModel（vLLM 后端）。仅在启动时调用一次。"""
    global _model
    if _model is not None:
        return _model
    log.info("loading Qwen3ASRModel (vLLM backend) from %s ...", MODEL_DIR)
    from qwen_asr import Qwen3ASRModel

    _model = Qwen3ASRModel.LLM(
        model=MODEL_DIR,
        gpu_memory_utilization=GPU_MEMORY_UTILIZATION,
        max_inference_batch_size=32,
        max_new_tokens=MAX_NEW_TOKENS,
    )
    log.info("model ready")
    return _model


# ---------------------------------------------------------------------------
# 会话
# ---------------------------------------------------------------------------
class SessionCreate(BaseModel):
    """兼容 MediaFlow RealtimeSessionCreate 的入参（多余字段忽略）。"""

    model: str | None = None
    language: str | None = None
    sample_rate: int = 16000
    format: str = "pcm_s16le"
    channels: int = 1
    mode: str = "2pass"
    hotwords: list[str] = Field(default_factory=list)
    prompt_hints: str = ""


class AudioChunk(BaseModel):
    """兼容 MediaFlow RealtimeAudioChunk。"""

    seq: int = 0
    audio: str = ""
    sample_rate: int | None = None
    format: str | None = None
    channels: int | None = None
    is_final: bool = False


_PCM_FORMATS = {"pcm", "pcm_s16le", "s16le", "raw", ""}


@dataclass
class Session:
    session_id: str
    config: SessionCreate
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    state: Any = None                       # qwen ASRStreamingState
    ffmpeg: Any = None                      # asyncio subprocess
    reader_task: asyncio.Task | None = None
    started: bool = False
    finished: bool = False
    seq: int = 0
    chunks_received: int = 0
    bytes_received: int = 0
    last_text: str = ""
    started_at: float = 0.0
    io_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    start_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    start_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    start_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


SESSIONS: dict[str, Session] = {}


def _elapsed_ms(s: Session) -> float:
    base = s.started_at or s.created_at
    return (time.time() - base) * 1000.0


def _emit(s: Session, evt_type: str, *, text: str = "", is_final: bool = False,
          error: str | None = None) -> None:
    s.seq += 1
    payload = {
        "type": evt_type,
        "seq": s.seq,
        "text": text,
        "is_final": is_final,
        "elapsed_ms": _elapsed_ms(s),
        "mode": "streaming",
    }
    if error is not None:
        payload["error"] = error
    s.queue.put_nowait(payload)


def _build_context(cfg: SessionCreate) -> str:
    parts: list[str] = []
    if cfg.prompt_hints:
        parts.append(cfg.prompt_hints.strip())
    if cfg.hotwords:
        parts.append(" ".join(h.strip() for h in cfg.hotwords if h.strip()))
    return " ".join(p for p in parts if p).strip()


async def _spawn_ffmpeg(cfg: SessionCreate, fmt: str) -> Any:
    """启动常驻 ffmpeg：stdin 收原始音频，stdout 输出 16k 单声道 s16le PCM。"""
    args: list[str] = [FFMPEG_BIN, "-hide_banner", "-loglevel", "error"]
    if fmt in _PCM_FORMATS:
        # 原始 PCM：需显式声明输入采样率/声道
        args += [
            "-f", "s16le",
            "-ar", str(cfg.sample_rate or SAMPLE_RATE),
            "-ac", str(cfg.channels or 1),
            "-i", "pipe:0",
        ]
    else:
        # 压缩容器（webm/ogg/wav/...）：让 ffmpeg 自动探测
        args += ["-i", "pipe:0"]
    args += [
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "-ac", "1",
        "-ar", str(SAMPLE_RATE),
        "pipe:1",
    ]
    log.info("[%s] spawning ffmpeg: %s", cfg.model or "", " ".join(args))
    return await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


async def _pcm_reader(s: Session) -> None:
    """从 ffmpeg stdout 增量读取 PCM，喂给 qwen 流式接口，推送部分结果。"""
    model = load_model()
    assert s.ffmpeg is not None and s.ffmpeg.stdout is not None
    stdout = s.ffmpeg.stdout
    try:
        while True:
            data = await stdout.read(READ_BLOCK_BYTES)
            if not data:
                break
            # 保证偶数字节（int16 对齐）
            if len(data) % 2:
                extra = await stdout.readexactly(1)
                data += extra
            pcm = np.frombuffer(data, dtype=np.int16)
            async with _model_lock:
                s.state = await asyncio.to_thread(
                    model.streaming_transcribe, pcm, s.state
                )
            text = s.state.text or ""
            if text and text != s.last_text:
                s.last_text = text
                _emit(s, "online", text=text, is_final=False)

        # 输入结束：flush 剩余缓冲，得到最终结果
        async with _model_lock:
            s.state = await asyncio.to_thread(
                model.finish_streaming_transcribe, s.state
            )
        final_text = s.state.text or s.last_text
        _emit(s, "final", text=final_text, is_final=True)
        _emit(s, "done", text=final_text, is_final=True)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("[%s] pcm reader failed", s.session_id)
        _emit(s, "error", error=str(e))
    finally:
        s.queue.put_nowait(None)
        await _reap_ffmpeg(s)


async def _reap_ffmpeg(s: Session) -> None:
    proc = s.ffmpeg
    if proc is None:
        return
    try:
        if proc.stdin and not proc.stdin.is_closing():
            proc.stdin.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        if proc.returncode is None:
            proc.terminate()
        await asyncio.wait_for(proc.wait(), timeout=5.0)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
    s.ffmpeg = None


async def _ensure_pipeline(s: Session, fmt: str) -> None:
    """首个音频包到达时启动 ffmpeg + 读取协程 + 初始化流式 state。"""
    if s.started:
        return
    async with s.start_lock:
        if s.started:
            return
        model = load_model()
        context = _build_context(s.config)
        language = s.config.language or None
        s.state = await asyncio.to_thread(
            model.init_streaming_state,
            context=context,
            language=language,
            chunk_size_sec=CHUNK_SIZE_SEC,
        )
        s.ffmpeg = await _spawn_ffmpeg(s.config, fmt)
        s.started_at = time.time()
        s.reader_task = asyncio.create_task(_pcm_reader(s))
        s.started = True


async def _close_input(s: Session) -> None:
    """结束输入：关闭 ffmpeg stdin，触发 reader flush 与 final/done。"""
    if s.finished:
        return
    s.finished = True
    if s.ffmpeg is None:
        # 从未收到任何音频：直接给出空结果收尾。
        if not s.started:
            _emit(s, "final", text="", is_final=True)
            _emit(s, "done", text="", is_final=True)
            s.queue.put_nowait(None)
        return
    async with s.io_lock:
        try:
            if s.ffmpeg.stdin and not s.ffmpeg.stdin.is_closing():
                s.ffmpeg.stdin.close()
        except Exception:  # noqa: BLE001
            log.warning("[%s] close stdin failed", s.session_id, exc_info=True)


def _prune_sessions() -> None:
    now = time.time()
    stale = [
        sid for sid, s in SESSIONS.items()
        if s.finished and (now - s.updated_at) > SESSION_TTL_SECONDS
    ]
    for sid in stale:
        SESSIONS.pop(sid, None)


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="Qwen3-ASR Streaming Service")


@app.on_event("startup")
async def _startup() -> None:
    # 启动即加载模型，使容器就绪 = 模型可用；/health 据此报告状态。
    await asyncio.to_thread(load_model)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "model_loaded": _model is not None}


@app.post("/session")
async def create_session(cfg: SessionCreate) -> dict:
    _prune_sessions()
    session_id = uuid.uuid4().hex
    SESSIONS[session_id] = Session(session_id=session_id, config=cfg)
    log.info("[%s] session created (format=%s, lang=%s)",
             session_id, cfg.format, cfg.language)
    return {"session_id": session_id}


@app.post("/session/{session_id}/audio")
async def push_audio(session_id: str, chunk: AudioChunk) -> dict:
    s = SESSIONS.get(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="session not found")
    if s.finished:
        raise HTTPException(status_code=409, detail="session already finished")

    s.updated_at = time.time()
    fmt = (chunk.format or s.config.format or "").lower().strip()

    if chunk.audio:
        try:
            data = base64.b64decode(chunk.audio, validate=True)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"invalid base64 audio: {e}")
        await _ensure_pipeline(s, fmt)
        s.chunks_received += 1
        s.bytes_received += len(data)
        async with s.io_lock:
            if s.ffmpeg is not None and s.ffmpeg.stdin is not None:
                try:
                    s.ffmpeg.stdin.write(data)
                    await s.ffmpeg.stdin.drain()
                except Exception as e:  # noqa: BLE001
                    log.warning("[%s] ffmpeg stdin write failed: %s", session_id, e)

    if chunk.is_final:
        await _close_input(s)
    return {"status": "ok"}


@app.post("/session/{session_id}/end")
async def end_session(session_id: str) -> dict:
    s = SESSIONS.get(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="session not found")
    await _close_input(s)
    return {"status": "ok"}


@app.get("/session/{session_id}")
async def session_info(session_id: str) -> dict:
    s = SESSIONS.get(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {
        "session_id": s.session_id,
        "chunks_received": s.chunks_received,
        "bytes_received": s.bytes_received,
        "finished": s.finished,
    }


@app.get("/session/{session_id}/events")
async def events(session_id: str) -> StreamingResponse:
    s = SESSIONS.get(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="session not found")

    async def gen():
        import json
        # 先补发已产生的历史事件（订阅可能晚于首个部分结果）。
        # 注意：queue 是单消费者；此处直接消费即可。
        while True:
            try:
                evt = await asyncio.wait_for(s.queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                # 心跳保活，避免代理断开长连接。
                yield ": keep-alive\n\n"
                continue
            if evt is None:
                break
            yield f"event: {evt['type']}\ndata: {json.dumps(evt, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8001"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
