from __future__ import annotations

import io
import json
import logging
import time
import uuid
import wave
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from sse_starlette.sse import EventSourceResponse
from starlette.background import BackgroundTask

from app.config import (
    SENSITIVE_FIELDS,
    WRITABLE_FIELDS,
    get_settings,
    reset_runtime_overrides,
    update_runtime_overrides,
)
from app.models.schemas import (
    ASRStreamEvent,
    RealtimeASREvent,
    RealtimeAudioChunk,
    RealtimeSessionCreate,
    RealtimeSessionInfo,
    SegmentEvent,
    TaskInfo,
    TaskResult,
    TaskStatus,
)
from app.security import require_token
from app.services.asr import (
    ASRError,
    create_provider,
    list_providers,
    list_realtime_providers,
)
from app.services.asr_monitoring import asr_call_context, asr_monitor
from app.services.asr.realtime_base import RealtimeASRError
from app.services.ffmpeg_service import FFmpegError, concat_media
from app.services.realtime_manager import RealtimeManager
from app.services.stream_manager import TaskManager
from app.services.stream_transcribe_manager import StreamTranscribeManager
from app.services.subtitles import to_srt, to_vtt

log = logging.getLogger(__name__)
router = APIRouter(prefix="/asr", tags=["asr"], dependencies=[Depends(require_token)])
meta_router = APIRouter(tags=["meta"])
media_router = APIRouter(
    prefix="/media", tags=["media"], dependencies=[Depends(require_token)]
)


def get_manager(request: Request) -> TaskManager:
    return request.app.state.manager


def get_realtime_manager(request: Request) -> RealtimeManager:
    return request.app.state.realtime_manager


def get_stream_transcribe_manager(request: Request) -> StreamTranscribeManager:
    return request.app.state.stream_transcribe_manager


ALLOWED_EXTS = {
    ".mp3",
    ".wav",
    ".m4a",
    ".flac",
    ".aac",
    ".ogg",
    ".pcm",
    ".mp4",
    ".mov",
    ".mkv",
}

STANDARD_FILE_ASR_DOC = """
给第三方调用的标准「上传 WAV/音频文件转文字」入口。

调用顺序：

1. `POST /asr/file` 上传 `multipart/form-data` 文件，字段名必须是 `file`。
2. 从返回值里立即取出并保存 `task_id`、`events_url`、`result_url`。
   `task_id` 是本次文件转写任务的唯一主键；切页面、SSE 断线或稍后查询时，都用它找回任务。
3. `GET /asr/file/{task_id}/events` 订阅 SSE，实时接收分片识别事件。
4. 任务完成后可 `GET /asr/file/{task_id}/result` 获取完整 JSON 结果。

返回事件说明：

- 所有事件名统一为 `event: message`，`data` 是 `ASRStreamEvent` JSON。
- `data.type=text`：识别文本事件。文件流每个分片都会产生一条 text 事件。
- `data.type=done`：任务正常结束。
- `data.type=error`：任务失败。
- 文件流的 `data.stream=file`，`data.id=data.task_id`；每条 text 事件都包含
  `task_id`、`segment_id`、`start`、`end`、`text`。

重要约定：

- 调用方应以 `POST /asr/file` 的响应作为 `task_id` 的可靠来源，并立刻保存。
- 文件流 `data.task_id` 是冗余带出，方便事件关联和日志排查；不要等第一条 `type=text`
  到达后才保存任务 ID，因为切分、排队、上游识别或失败场景可能导致分片延迟或不存在。
- 页面切走或 SSE 断开后，用已保存的 `task_id` 重新请求
  `/asr/file/{task_id}/events`；如果任务已经结束，使用 `/asr/file/{task_id}/result`
  取最终结果。

当前服务端已经接入 Qwen ASR；这个接口屏蔽了底层 provider 差异，调用方只需要按
标准上传文件和订阅 SSE。

真实数据配置：

- 文件接口使用 `ASR_PROVIDER`、`ASR_BASE_URL`、`ASR_API_KEY`、`ASR_MODEL`。
- Qwen3-ASR-Flash 走 DashScope chat/audio 兼容接口时，`ASR_PROVIDER` 应设置为
  `openai_chat_audio`，`ASR_MODEL=qwen3-asr-flash`。
- 文件接口不使用 `REALTIME_ASR_PROVIDER`；如果文件接口返回异常，应优先检查
  `POST /asr/ping` 和文件 ASR 配置。
"""

STANDARD_FILE_EVENTS_DOC = """
订阅文件转写任务的 SSE 事件流。

适用于「上传 WAV 文件转文字，流式返回文字」场景。客户端应使用支持 SSE 的方式
保持长连接，例如浏览器 `EventSource` 或命令行 `curl -N`。

事件格式：

```text
event: message
data: {"type":"text","stream":"file","id":"...","text":"...","is_final":true,"seq":1,"task_id":"...","segment_id":1,"start":0.0,"end":30.0}

event: message
data: {"type":"done","stream":"file","id":"...","text":"","is_final":true,"task_id":"...","status":"done","progress":1.0}
```

这个接口和 `/asr/realtime/{session_id}/events` 的 SSE 格式一致：都监听 `event: message`，
都解析 `data.type`、`data.stream`、`data.id`、`data.text`、`data.is_final`。文件流额外
提供 `task_id`、`segment_id`、`start`、`end`。

`data.task_id` 会在每条文件 text 事件中返回，用于前端多任务并行、页面切换后的事件归属、
日志排查和断线恢复。但任务 ID 的可靠来源仍然是 `POST /asr/file` 的响应；客户端应在上传
成功后立即保存它。不要依赖第一条 `type=text` 才拿 `task_id`，因为第一条分片可能在切分、
排队或上游识别完成后才出现，失败时也可能不会出现。

页面切走或 SSE 断开后，用保存的 `task_id` 重新连接
`/asr/file/{task_id}/events`。如果任务已经完成，建议直接请求
`/asr/file/{task_id}/result` 获取最终结果。

如果启用了访问令牌，浏览器 `EventSource` 不能加 Header，可使用
`?token=你的token` 查询参数。
"""

STANDARD_FILE_EVENTS_RESPONSE = {
    200: {
        "description": "SSE 事件流；统一返回 message，data.type 为 text / done / error。",
        "content": {
            "text/event-stream": {
                "example": (
                    'event: message\n'
                    'data: {"type":"text","stream":"file","id":"abc",'
                    '"text":"识别文本","is_final":true,"seq":1,'
                    '"session_id":null,"task_id":"abc","segment_id":1,'
                    '"start":0.0,"end":30.0,"elapsed_ms":120.0,'
                    '"status":null,"progress":null,"error":null,'
                    '"source_event":"segment"}\n\n'
                    'event: message\n'
                    'data: {"type":"done","stream":"file","id":"abc",'
                    '"text":"","is_final":true,"seq":null,"session_id":null,'
                    '"task_id":"abc","segment_id":null,"start":null,"end":null,'
                    '"elapsed_ms":0.0,"status":"done","progress":1.0,'
                    '"error":null,"source_event":"done"}\n\n'
                )
            }
        },
    }
}

STANDARD_FILE_RESULT_DOC = """
获取文件转写任务最终结果。

任务未完成时返回 HTTP 202，完成后返回包含 `text`、`segments`、`duration`、
`language`、`error` 等字段的 JSON。`segments` 中保留每个分片的时间范围和文本。
"""

REALTIME_SESSION_DOC = """
创建一个实时录音转文字会话。

给第三方调用的标准 realtime 入口。创建成功后返回：

- `session_id`：后续上传音频和订阅事件都要使用。
- `events_url`：SSE 文字流地址。
- `audio_url`：base64 音频 chunk 上传地址。
- `end_url`：主动结束会话地址。

当前 Qwen ASR 通过 `realtime_offline` 封装时，不是底层模型原生实时识别：
服务端会先接收 base64 chunks，收到结束信号后调用 Qwen ASR，再用统一 SSE 输出
`type=text` 和 `type=done`。后续切换到原生实时 ASR 时，客户端接口不需要改。

如果 SSE 里看到 `...mock partial...` 或 `Mock final transcription.`，说明当前仍是
`REALTIME_ASR_PROVIDER=realtime_mock`。要让实时接口返回真实 Qwen 识别文本，请把配置改为：

```env
ASR_PROVIDER=openai_chat_audio
ASR_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ASR_API_KEY=<你的 DashScope API Key>
ASR_MODEL=qwen3-asr-flash
REALTIME_ASR_PROVIDER=realtime_offline
```

在 Web 页面「服务配置」里对应设置为：接口类型 `openai_chat_audio`，实时接口类型
`realtime_offline`。设置后先点「测试连接」或调用 `POST /asr/ping`，确认 `ok=true`。

`realtime_offline` 会先缓存 base64 音频，收到 `is_final=true` 或 `/end` 后才调用真实 ASR；
它返回的流是模拟流式，不是模型原生低延迟实时。需要原生实时时，请使用 `realtime_http`
并接入符合本项目实时协议的下游服务。

音频格式说明：

- 实时录音裸流建议使用 `pcm_s16le`，并正确填写 `sample_rate`、`channels`。
- 浏览器 `MediaRecorder` 常见格式是 `webm` / `ogg`，创建会话时建议把 `format` 填成实际值。
- `realtime_offline` 会自动检测 WAV/WebM/Ogg/MP3/FLAC/M4A 等常见容器；如果检测到容器音频，
  会先用 ffmpeg 转成 16k 单声道 WAV，再调用 Qwen ASR。监控页会显示声明格式和检测格式。
"""

REALTIME_AUDIO_DOC = """
向实时会话上传一段 base64 音频。

调用方式：

1. 客户端录音后按小块切分音频。
2. 每块 base64 编码后调用本接口，`is_final=false`。
3. 音频结束时，再发送一个 `is_final=true` 的包；此时 `audio` 可以为空字符串。

请求体示例：

```json
{"seq":1,"audio":"base64音频片段","is_final":false}
```

结束包示例：

```json
{"seq":99,"audio":"","is_final":true}
```

单包解码后的大小受 `REALTIME_MAX_CHUNK_BYTES` 限制。
"""

REALTIME_EVENTS_DOC = """
订阅实时识别结果的 SSE 事件流。

事件格式与 `/asr/file/{task_id}/events` 一致，调用方只需要一套 SSE 解析逻辑：

```text
event: message
data: {"type":"text","stream":"realtime","id":"...","text":"中间识别结果","is_final":false,"seq":1,"session_id":"...","source_event":"online"}

event: message
data: {"type":"text","stream":"realtime","id":"...","text":"最终识别文本","is_final":true,"session_id":"...","source_event":"final"}

event: message
data: {"type":"done","stream":"realtime","id":"...","text":"","is_final":true,"session_id":"...","source_event":"done"}
```

统一字段：

- `type=text`：识别文本事件。`is_final=false` 表示中间结果，`is_final=true` 表示稳定文本。
- `type=done`：会话正常结束。
- `type=error`：识别失败或上游异常。
- `stream=realtime`，`id=session_id`。
- `source_event` 保留底层事件名，例如 `online`、`final`、`done`、`error`，用于调试。

真实数据配置：

- 默认 `REALTIME_ASR_PROVIDER=realtime_mock` 只返回演示文本，例如 `...mock partial...`。
- 使用 Qwen3-ASR-Flash 时，把 `REALTIME_ASR_PROVIDER` 改成 `realtime_offline`，并同时配置
  `ASR_PROVIDER=openai_chat_audio`、`ASR_BASE_URL`、`ASR_API_KEY`、`ASR_MODEL=qwen3-asr-flash`。
- `realtime_offline` 只有在收到结束信号后才调用真实 ASR；调用方必须发送
  `{"audio":"","is_final":true}` 或调用 `POST /asr/realtime/{session_id}/end`。

如果启用了访问令牌，浏览器 `EventSource` 不能加 Header，可使用
`?token=你的token` 查询参数。
"""

REALTIME_EVENTS_RESPONSE = {
    200: {
        "description": "SSE 事件流；统一返回 message，data.type 为 text / done / error。",
        "content": {
            "text/event-stream": {
                "example": (
                    'event: message\n'
                    'data: {"type":"text","stream":"realtime","id":"abc",'
                    '"text":"中间识别结果","is_final":false,"seq":1,'
                    '"session_id":"abc","task_id":null,"segment_id":null,'
                    '"start":null,"end":null,"elapsed_ms":30.0,'
                    '"status":null,"progress":null,"error":null,'
                    '"source_event":"online"}\n\n'
                    'event: message\n'
                    'data: {"type":"done","stream":"realtime","id":"abc",'
                    '"text":"","is_final":true,"seq":null,"session_id":"abc",'
                    '"task_id":null,"segment_id":null,"start":null,"end":null,'
                    '"elapsed_ms":0.0,"status":null,"progress":null,'
                    '"error":null,"source_event":"done"}\n\n'
                )
            }
        },
    }
}

REALTIME_END_DOC = """
主动结束实时会话。

等价于发送 `{"audio":"","is_final":true}` 的结束包。服务端收到结束信号后会触发
最终识别，并通过 `/asr/realtime/{session_id}/events` 输出统一的 `message` 事件。
"""

ASR_MONITOR_DOC = """
查看当前服务进程内的 ASR 上游调用快照。

这个接口用于确认本项目是否真正调用了 Qwen ASR 或其他上游 ASR，以及每次调用的来源、
模型、耗时、请求音频大小、返回文本长度和错误信息。监控记录保存在内存滚动窗口里，
默认最近 200 条；服务重启后会清空，多副本部署时每个副本各自记录。

返回字段：

- `summary.total`：当前窗口内调用数。
- `summary.running`：仍在等待上游返回的调用数。
- `summary.succeeded` / `summary.failed`：成功和失败调用数。
- `summary.avg_elapsed_ms`：已结束调用的平均耗时。
- `calls[]`：调用明细，包含 `source`、`task_id`、`session_id`、`segment_id`、
  `provider`、`model`、`status`、`request_bytes`、`text_chars`、`text_preview`、
  `declared_format`、`detected_format`、`input_bytes`、`audio_duration_ms`、
  `elapsed_ms`、`error`。
- `config`：当前 ASR 配置摘要，不返回明文 API Key。

常见 `source`：

- `file_task`：`POST /asr/file` 或旧版 `/asr/task` 创建的文件分片识别。
- `realtime_offline`：实时接口结束后，用文件 ASR 封装调用 Qwen ASR。
- `stream_transcribe`：旧版流式转写入口。
- `ping`：服务配置页「测试连接」或 `POST /asr/ping`。
"""

ASR_MONITOR_EVENTS_DOC = """
订阅 ASR 上游调用监控的 SSE 事件流。

页面可先调用 `GET /asr/monitor` 获取快照，也可以直接订阅本接口。本接口建立连接后
会先发送一条 `event: snapshot`，之后每次上游调用开始和结束都会推送增量事件。

事件格式：

```text
event: snapshot
data: {"summary":{...},"calls":[...],"config":{...}}

event: call_started
data: {"type":"call_started","call":{"call_id":"...","status":"running",...}}

event: call_finished
data: {"type":"call_finished","call":{"call_id":"...","status":"ok","elapsed_ms":320.1,...}}
```

如果调用失败，`call.status=error`，`call.error` 中会包含上游 HTTP 状态、超时或协议错误摘要。
如果启用了访问令牌，浏览器 `EventSource` 可使用 `?token=你的token` 查询参数。
"""


def _sse_message(payload: ASRStreamEvent) -> dict[str, str]:
    return {"event": "message", "data": payload.model_dump_json()}


def _standard_file_segment_sse_message(evt: SegmentEvent) -> dict[str, str]:
    return _sse_message(
        ASRStreamEvent(
            type="text",
            stream="file",
            id=evt.task_id,
            text=evt.text,
            is_final=evt.is_final,
            seq=evt.segment_id,
            task_id=evt.task_id,
            segment_id=evt.segment_id,
            start=evt.start,
            end=evt.end,
            elapsed_ms=evt.elapsed_ms,
            error=evt.error,
            source_event="segment",
        )
    )


def _standard_file_done_sse_message(info: TaskInfo) -> dict[str, str]:
    event_type = "error" if info.status == TaskStatus.failed else "done"
    return _sse_message(
        ASRStreamEvent(
            type=event_type,
            stream="file",
            id=info.task_id,
            is_final=True,
            task_id=info.task_id,
            status=info.status.value,
            progress=info.progress,
            error=info.error,
            source_event="done" if event_type == "done" else "error",
        )
    )


def _standard_realtime_sse_message(evt: RealtimeASREvent) -> dict[str, str]:
    if evt.type == "done":
        event_type = "done"
    elif evt.type == "error":
        event_type = "error"
    else:
        event_type = "text"

    return _sse_message(
        ASRStreamEvent(
            type=event_type,
            stream="realtime",
            id=evt.session_id,
            text=evt.text,
            is_final=evt.is_final or evt.type in {"final", "done"},
            seq=evt.seq,
            session_id=evt.session_id,
            elapsed_ms=evt.elapsed_ms,
            error=evt.error,
            source_event=evt.type,
        )
    )


@router.post("/task")
async def create_task(
    file: UploadFile = File(...),
    model: str | None = Form(default=None),
    language: str | None = Form(default=None),
    split_strategy: str | None = Form(default=None),
    chunk_seconds: float | None = Form(default=None),
    overlap_seconds: float | None = Form(default=None),
    hotwords: str | None = Form(default=None),
    prompt_hints: str | None = Form(default=None),
    timestamps: bool | None = Form(default=None),
    manager: TaskManager = Depends(get_manager),
) -> dict[str, str]:
    settings = get_settings()
    if not file.filename:
        raise HTTPException(400, "missing filename")
    suffix = Path(file.filename).suffix.lower()
    if suffix and suffix not in ALLOWED_EXTS:
        raise HTTPException(400, f"unsupported file type: {suffix}")

    upload_id = uuid.uuid4().hex
    dst = settings.temp_dir / f"upload_{upload_id}{suffix or '.bin'}"
    limit = settings.max_upload_bytes
    written = 0
    try:
        async with aiofiles.open(dst, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > limit:
                    raise HTTPException(413, f"upload exceeds {limit} bytes")
                await out.write(chunk)
    except HTTPException:
        dst.unlink(missing_ok=True)
        raise
    except Exception:
        dst.unlink(missing_ok=True)
        raise

    overrides: dict = {}
    if model is not None:
        overrides["asr_model"] = model
    if language is not None:
        overrides["asr_language"] = language or None
    if split_strategy is not None:
        if split_strategy not in {"fixed", "silence", "overlap"}:
            dst.unlink(missing_ok=True)
            raise HTTPException(400, "split_strategy must be fixed|silence|overlap")
        overrides["split_strategy"] = split_strategy
    if chunk_seconds is not None:
        overrides["split_chunk_seconds"] = chunk_seconds
    if overlap_seconds is not None:
        overrides["split_overlap_seconds"] = overlap_seconds
    if hotwords is not None:
        overrides["asr_hotwords"] = hotwords
    if prompt_hints is not None:
        overrides["asr_prompt_hints"] = prompt_hints
    if timestamps is not None:
        overrides["asr_timestamps"] = timestamps

    task_id = await manager.submit(dst, file.filename, overrides=overrides or None)
    return {"task_id": task_id}


@router.post(
    "/file",
    summary="2. 上传 WAV 文件转文字（SSE 流式返回）",
    description=STANDARD_FILE_ASR_DOC,
    response_description="返回 task_id 以及状态、事件流、最终结果 URL。",
)
async def create_file_transcription(
    file: UploadFile = File(
        ...,
        description="要识别的 WAV/音频/视频文件。字段名固定为 file。",
    ),
    model: str | None = Form(default=None, description="可选：本次任务覆盖模型名称。"),
    language: str | None = Form(default=None, description="可选：识别语言，例如 zh / en。"),
    split_strategy: str | None = Form(
        default=None,
        description="可选：切分策略 fixed / silence / overlap；留空用服务端默认值。",
    ),
    chunk_seconds: float | None = Form(
        default=None,
        description="可选：每个分片目标时长，单位秒。",
    ),
    overlap_seconds: float | None = Form(
        default=None,
        description="可选：重叠切分时的重叠时长，单位秒。",
    ),
    hotwords: str | None = Form(
        default=None,
        description="可选：热词，逗号分隔；是否生效取决于底层 ASR provider。",
    ),
    prompt_hints: str | None = Form(
        default=None,
        description="可选：上下文提示词；是否生效取决于底层 ASR provider。",
    ),
    timestamps: bool | None = Form(
        default=None,
        description="可选：是否请求时间戳；上游不支持时建议传 false。",
    ),
    manager: TaskManager = Depends(get_manager),
) -> dict[str, str]:
    """Standard file-ASR entrypoint.

    Internally this is the same durable task pipeline as `/asr/task`, but the
    response advertises the stable stream/result URLs expected by ASR clients.
    """
    task = await create_task(
        file=file,
        model=model,
        language=language,
        split_strategy=split_strategy,
        chunk_seconds=chunk_seconds,
        overlap_seconds=overlap_seconds,
        hotwords=hotwords,
        prompt_hints=prompt_hints,
        timestamps=timestamps,
        manager=manager,
    )
    task_id = task["task_id"]
    return {
        "task_id": task_id,
        "status_url": f"/asr/file/{task_id}",
        "events_url": f"/asr/file/{task_id}/events",
        "result_url": f"/asr/file/{task_id}/result",
    }


def _unlink_all(paths: list[Path]) -> None:
    for p in paths:
        p.unlink(missing_ok=True)


@media_router.post("/concat")
async def concat_media_files(files: list[UploadFile] = File(...)) -> FileResponse:
    """Merge same-format audio/video files in upload order without re-encoding.

    Stream-copy concat (ffmpeg concat demuxer): the output format equals the
    input format. All inputs must share one container/codec; mixing is rejected.
    """
    settings = get_settings()
    if len(files) < 2:
        raise HTTPException(400, "concat needs at least two files")

    suffixes = set()
    for f in files:
        if not f.filename:
            raise HTTPException(400, "missing filename")
        suffix = Path(f.filename).suffix.lower()
        if suffix not in ALLOWED_EXTS:
            raise HTTPException(400, f"unsupported file type: {suffix}")
        suffixes.add(suffix)
    if len(suffixes) != 1:
        raise HTTPException(400, "all files must share the same format")
    suffix = suffixes.pop()

    job_id = uuid.uuid4().hex
    limit = settings.max_upload_bytes
    parts = [
        settings.temp_dir / f"concat_{job_id}_{i}{suffix}" for i in range(len(files))
    ]
    dst = settings.temp_dir / f"concat_{job_id}{suffix}"
    written = 0
    try:
        for f, part in zip(files, parts):
            async with aiofiles.open(part, "wb") as out:
                while chunk := await f.read(1024 * 1024):
                    written += len(chunk)
                    if written > limit:
                        raise HTTPException(413, f"upload exceeds {limit} bytes")
                    await out.write(chunk)
        await concat_media(parts, dst, timeout=settings.ffmpeg_timeout)
    except HTTPException:
        _unlink_all(parts + [dst])
        raise
    except FFmpegError as e:
        _unlink_all(parts + [dst])
        raise HTTPException(400, f"concat failed: {e}") from e
    except Exception:
        _unlink_all(parts + [dst])
        raise

    return FileResponse(
        dst,
        filename=f"concat{suffix}",
        background=BackgroundTask(_unlink_all, parts + [dst]),
    )


@router.get("/task/{task_id}", response_model=TaskInfo)
async def get_status(
    task_id: str, manager: TaskManager = Depends(get_manager)
) -> TaskInfo:
    info = manager.get_info(task_id)
    if info is None:
        raise HTTPException(404, "task not found")
    return info


@router.get(
    "/file/{task_id}",
    response_model=TaskInfo,
    summary="查询标准文件转写任务状态",
    description="根据 `task_id` 查询上传文件转写任务的状态、进度、分片数量和错误信息。",
)
async def get_file_status(
    task_id: str, manager: TaskManager = Depends(get_manager)
) -> TaskInfo:
    return await get_status(task_id=task_id, manager=manager)


@router.get("/task/{task_id}/stream")
async def stream_task(
    task_id: str, manager: TaskManager = Depends(get_manager)
) -> EventSourceResponse:
    if manager.get_info(task_id) is None:
        raise HTTPException(404, "task not found")

    async def event_gen():
        async for evt in manager.stream(task_id):
            yield {"event": "segment", "data": evt.model_dump_json()}
        info = manager.get_info(task_id)
        if info is not None:
            yield {"event": "done", "data": info.model_dump_json()}

    return EventSourceResponse(event_gen())


@router.get(
    "/file/{task_id}/events",
    summary="2. 订阅 WAV 文件转文字 SSE 流",
    description=STANDARD_FILE_EVENTS_DOC,
    responses=STANDARD_FILE_EVENTS_RESPONSE,
)
async def stream_file_transcription(
    task_id: str, manager: TaskManager = Depends(get_manager)
) -> EventSourceResponse:
    if manager.get_info(task_id) is None:
        raise HTTPException(404, "task not found")

    async def event_gen():
        async for evt in manager.stream(task_id):
            yield _standard_file_segment_sse_message(evt)
        info = manager.get_info(task_id)
        if info is not None:
            yield _standard_file_done_sse_message(info)

    return EventSourceResponse(event_gen())


@router.get("/task/{task_id}/result", response_model=TaskResult)
async def get_result(
    task_id: str, manager: TaskManager = Depends(get_manager)
) -> TaskResult | Response:
    result = manager.get_result(task_id)
    if result is None:
        raise HTTPException(404, "task not found")
    if result.status not in {TaskStatus.done, TaskStatus.failed}:
        return JSONResponse(status_code=202, content=result.model_dump(mode="json"))
    return result


@router.get(
    "/file/{task_id}/result",
    response_model=TaskResult,
    summary="获取标准文件转写最终结果",
    description=STANDARD_FILE_RESULT_DOC,
)
async def get_file_result(
    task_id: str, manager: TaskManager = Depends(get_manager)
) -> TaskResult | Response:
    return await get_result(task_id=task_id, manager=manager)


@router.get("/task/{task_id}/subtitle", response_class=PlainTextResponse)
async def get_subtitle(
    task_id: str,
    format: str = "srt",
    manager: TaskManager = Depends(get_manager),
) -> Response:
    fmt = format.lower()
    if fmt not in {"srt", "vtt"}:
        raise HTTPException(400, "format must be 'srt' or 'vtt'")
    result = manager.get_result(task_id)
    if result is None:
        raise HTTPException(404, "task not found")
    if result.status != TaskStatus.done:
        raise HTTPException(409, f"task not ready (status={result.status.value})")

    body = to_srt(result.segments) if fmt == "srt" else to_vtt(result.segments)
    media = "application/x-subrip" if fmt == "srt" else "text/vtt"
    return Response(
        content=body,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{task_id}.{fmt}"'},
    )


@router.get(
    "/file/{task_id}/subtitle",
    response_class=PlainTextResponse,
    summary="下载标准文件转写字幕",
    description="下载指定文件转写任务的 SRT 或 VTT 字幕。任务未完成时返回 409。",
)
async def get_file_subtitle(
    task_id: str,
    format: str = "srt",
    manager: TaskManager = Depends(get_manager),
) -> Response:
    return await get_subtitle(task_id=task_id, format=format, manager=manager)


@meta_router.get("/auth/info")
async def auth_info() -> dict[str, bool]:
    return {"auth_required": bool(get_settings().access_tokens_list)}


@router.get("/config")
async def get_config() -> dict:
    """Effective server configuration. Secrets (API key, tokens) are not included."""
    s = get_settings()
    return {
        "provider": s.asr_provider,
        "available_providers": list_providers(),
        "base_url": s.asr_base_url,
        "model": s.asr_model,
        "language": s.asr_language,
        "timeout": s.asr_timeout,
        "timestamps": s.asr_timestamps,
        "hotwords": s.asr_hotwords,
        "prompt_hints": s.asr_prompt_hints,
        "split_strategy": s.split_strategy,
        "chunk_seconds": s.split_chunk_seconds,
        "overlap_seconds": s.split_overlap_seconds,
        "silence_noise_db": s.silence_noise_db,
        "silence_min_duration": s.silence_min_duration,
        "concurrency": s.asr_concurrency,
        "max_retries": s.asr_max_retries,
        "retry_backoff": s.asr_retry_backoff,
        "ffmpeg_timeout": s.ffmpeg_timeout,
        "ffmpeg_concurrency": s.ffmpeg_concurrency,
        "max_upload_bytes": s.max_upload_bytes,
        "realtime_asr_provider": s.realtime_asr_provider,
        "realtime_asr_base_url": s.realtime_asr_base_url,
        "realtime_asr_model": s.realtime_asr_model,
        "realtime_session_ttl_seconds": s.realtime_session_ttl_seconds,
        "realtime_max_sessions": s.realtime_max_sessions,
        "realtime_max_chunk_bytes": s.realtime_max_chunk_bytes,
        "realtime_api_key_set": bool(s.realtime_asr_api_key),
        "api_key_set": bool(s.asr_api_key),
        "access_tokens_count": len(s.access_tokens_list),
        "writable_fields": sorted(WRITABLE_FIELDS),
        "sensitive_fields": sorted(SENSITIVE_FIELDS),
        "runtime_config_path": str(s.runtime_config_path),
    }


@router.post("/config")
async def post_config(body: dict) -> dict:
    """Update runtime overrides (validated, persisted, applied to live Settings)."""
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    if not body:
        raise HTTPException(400, "no fields to update")

    # Empty-string fields are kept (user wants to clear), but we strip None.
    updates = {k: v for k, v in body.items() if v is not None}

    if "asr_provider" in updates and updates["asr_provider"] not in list_providers():
        raise HTTPException(
            400,
            f"unknown provider: {updates['asr_provider']}; available: {list_providers()}",
        )
    if (
        "realtime_asr_provider" in updates
        and updates["realtime_asr_provider"] not in list_realtime_providers()
    ):
        raise HTTPException(
            400,
            f"unknown realtime provider: {updates['realtime_asr_provider']}; "
            f"available: {list_realtime_providers()}",
        )
    if "split_strategy" in updates and updates["split_strategy"] not in {
        "fixed",
        "silence",
        "overlap",
    }:
        raise HTTPException(400, "split_strategy must be fixed|silence|overlap")

    try:
        update_runtime_overrides(updates)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # pydantic validation etc.
        raise HTTPException(400, f"invalid update: {e}")

    return await get_config()


@router.post("/config/reset")
async def post_config_reset() -> dict:
    """Drop runtime overrides; revert all writable fields to .env defaults."""
    reset_runtime_overrides()
    return await get_config()


@router.get(
    "/monitor",
    summary="3. 查看 ASR 上游调用监控快照",
    description=ASR_MONITOR_DOC,
)
async def get_asr_monitor() -> dict:
    """Return in-memory ASR upstream call metrics."""
    settings = get_settings()
    snapshot = asr_monitor.snapshot()
    snapshot["config"] = {
        "provider": settings.asr_provider,
        "model": settings.asr_model,
        "base_url": settings.asr_base_url,
        "api_key_set": bool(settings.asr_api_key),
        "realtime_asr_provider": settings.realtime_asr_provider,
    }
    return snapshot


@router.get(
    "/monitor/events",
    summary="3.1 订阅 ASR 上游调用监控事件（SSE）",
    description=ASR_MONITOR_EVENTS_DOC,
)
async def stream_asr_monitor_events() -> EventSourceResponse:
    """SSE stream of ASR upstream call metric updates."""

    async def event_gen():
        yield {
            "event": "snapshot",
            "data": json.dumps(await get_asr_monitor(), ensure_ascii=False),
        }
        async for event in asr_monitor.subscribe():
            yield {
                "event": event["type"],
                "data": json.dumps(event, ensure_ascii=False),
            }

    return EventSourceResponse(event_gen())


def _silent_wav_bytes(duration: float = 1.0, sample_rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * int(sample_rate * duration))
    return buf.getvalue()


@router.post("/ping")
async def ping_upstream() -> dict:
    """Send a 1s silent WAV to the configured ASR backend and report status."""
    settings = get_settings()
    tmp = settings.temp_dir / f"ping_{uuid.uuid4().hex}.wav"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(_silent_wav_bytes())

    t0 = time.perf_counter()
    try:
        async with create_provider(settings) as provider:
            with asr_call_context(source="ping"):
                res = await provider.transcribe(tmp)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return {
            "ok": True,
            "elapsed_ms": round(elapsed_ms, 1),
            "provider": settings.asr_provider,
            "base_url": settings.asr_base_url,
            "model": settings.asr_model,
            "text_preview": res.text[:100],
            "got_words": bool(res.words),
        }
    except ASRError as e:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return {
            "ok": False,
            "elapsed_ms": round(elapsed_ms, 1),
            "provider": settings.asr_provider,
            "base_url": settings.asr_base_url,
            "model": settings.asr_model,
            "error": str(e),
        }
    finally:
        tmp.unlink(missing_ok=True)


@router.get("/tasks")
async def list_tasks(
    manager: TaskManager = Depends(get_manager),
    limit: int = 50,
) -> dict:
    """List completed tasks (from outputs/ + in-memory active ones)."""
    s = get_settings()
    seen: set[str] = set()
    items: list[dict] = []

    # In-memory tasks (active + recently completed)
    for tid, t in list(manager._tasks.items()):  # noqa: SLF001
        seen.add(tid)
        items.append(
            {
                "task_id": tid,
                "status": t.info.status.value,
                "progress": t.info.progress,
                "total_segments": t.info.total_segments,
                "finished_segments": t.info.finished_segments,
                "duration": t.result.duration,
                "text_preview": (t.result.text or "")[:120],
                "error": t.info.error,
                "in_memory": True,
            }
        )

    # Persisted task results
    out_dir = s.output_dir
    if out_dir.is_dir():
        import json as _json

        for path in sorted(
            out_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
        ):
            tid = path.stem
            if tid in seen:
                continue
            try:
                data = _json.loads(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
            items.append(
                {
                    "task_id": tid,
                    "status": data.get("status", "done"),
                    "progress": 1.0,
                    "total_segments": len(data.get("segments", [])),
                    "finished_segments": len(data.get("segments", [])),
                    "duration": data.get("duration", 0.0),
                    "text_preview": (data.get("text") or "")[:120],
                    "error": data.get("error"),
                    "in_memory": False,
                    "mtime": path.stat().st_mtime,
                }
            )

    return {"tasks": items[:limit], "total": len(items)}


@router.get("/task/{task_id}/segments/{segment_id}/raw")
async def get_segment_raw(
    task_id: str,
    segment_id: int,
    manager: TaskManager = Depends(get_manager),
) -> dict:
    """Return the raw upstream ASR payload for a single segment (debug aid)."""
    result = manager.get_result(task_id)
    if result is None:
        raise HTTPException(404, "task not found")
    for seg in result.segments:
        if seg.segment_id == segment_id:
            return {
                "segment_id": seg.segment_id,
                "elapsed_ms": seg.elapsed_ms,
                "words": [w.model_dump() for w in seg.words],
                "raw": seg.raw,
                "error": seg.error,
            }
    raise HTTPException(404, "segment not found")


# -------------------- Realtime --------------------


@router.post(
    "/realtime/session",
    response_model=RealtimeSessionInfo,
    summary="1. 实时录音转文字：创建会话",
    description=REALTIME_SESSION_DOC,
    response_description="返回实时会话 ID、音频上传 URL、SSE 订阅 URL 和结束 URL。",
)
async def create_realtime_session(
    config: RealtimeSessionCreate,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> RealtimeSessionInfo:
    try:
        return await rm.create(config)
    except RealtimeASRError as e:
        raise HTTPException(503, str(e))


@router.get(
    "/realtime/sessions",
    summary="查看实时识别会话和可用 provider",
    description="返回当前活跃实时会话、已注册 realtime provider、当前生效 provider。",
)
async def list_realtime_sessions(
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> dict:
    return {
        "sessions": [s.model_dump() for s in rm.list()],
        "providers": list_realtime_providers(),
        "active_provider": get_settings().realtime_asr_provider,
    }


@router.get(
    "/realtime/{session_id}",
    response_model=RealtimeSessionInfo,
    summary="查询实时识别会话状态",
    description="根据 `session_id` 查询当前实时会话的状态、已接收 chunk 数和字节数。",
)
async def get_realtime_session(
    session_id: str,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> RealtimeSessionInfo:
    info = rm.get(session_id)
    if info is None:
        raise HTTPException(404, "session not found")
    return info


@router.post(
    "/realtime/{session_id}/audio",
    summary="1. 实时录音转文字：上传 base64 音频 chunk",
    description=REALTIME_AUDIO_DOC,
    response_description="返回当前 chunk 是否接收成功。",
)
async def push_realtime_audio(
    session_id: str,
    chunk: RealtimeAudioChunk,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> dict:
    try:
        await rm.push_audio(session_id, chunk)
    except KeyError:
        raise HTTPException(404, "session not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RealtimeASRError as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "seq": chunk.seq}


@router.get(
    "/realtime/{session_id}/events",
    summary="1. 实时录音转文字：订阅 SSE 文字流",
    description=REALTIME_EVENTS_DOC,
    responses=REALTIME_EVENTS_RESPONSE,
)
async def stream_realtime_session(
    session_id: str,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> EventSourceResponse:
    if rm.get(session_id) is None:
        raise HTTPException(404, "session not found")

    async def event_gen():
        async for evt in rm.stream(session_id):
            yield _standard_realtime_sse_message(evt)
        info = rm.get(session_id)
        if info is not None and info.status.value not in {"done", "failed", "closed"}:
            # safety fallback if the stream ended without a terminal event
            terminal = RealtimeASREvent(
                type="done", session_id=session_id, is_final=True
            )
            yield _standard_realtime_sse_message(terminal)

    return EventSourceResponse(event_gen())


@router.post(
    "/realtime/{session_id}/end",
    summary="1. 实时录音转文字：结束会话",
    description=REALTIME_END_DOC,
)
async def end_realtime_session(
    session_id: str,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> dict:
    try:
        await rm.finish(session_id)
    except KeyError:
        raise HTTPException(404, "session not found")
    return {"ok": True}


@router.delete(
    "/realtime/{session_id}",
    summary="删除实时识别会话",
    description="关闭并释放实时会话资源。通常测试完成或客户端退出时调用。",
)
async def delete_realtime_session(
    session_id: str,
    rm: RealtimeManager = Depends(get_realtime_manager),
) -> dict:
    removed = await rm.close(session_id)
    if not removed:
        raise HTTPException(404, "session not found")
    return {"ok": True}


@router.post("/transcribe-stream")
async def create_transcribe_stream(
    file: UploadFile = File(...),
    model: str | None = Form(default=None),
    language: str | None = Form(default=None),
    stm: StreamTranscribeManager = Depends(get_stream_transcribe_manager),
) -> dict:
    """上传音频文件并创建流式转录会话"""
    settings = get_settings()
    if not file.filename:
        raise HTTPException(400, "missing filename")
    suffix = Path(file.filename).suffix.lower()
    if suffix and suffix not in ALLOWED_EXTS:
        raise HTTPException(400, f"unsupported file type: {suffix}")

    upload_id = uuid.uuid4().hex
    dst = settings.temp_dir / f"stream_{upload_id}{suffix or '.bin'}"
    limit = settings.max_upload_bytes
    written = 0
    try:
        async with aiofiles.open(dst, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > limit:
                    raise HTTPException(413, f"upload exceeds {limit} bytes")
                await out.write(chunk)
    except HTTPException:
        dst.unlink(missing_ok=True)
        raise
    except Exception:
        dst.unlink(missing_ok=True)
        raise

    config = RealtimeSessionCreate(
        model=model or settings.asr_model,
        language=language or settings.asr_language,
    )
    session_id = await stm.create_session(dst, config)
    return {
        "session_id": session_id,
        "events_url": f"/asr/transcribe-stream/{session_id}/events",
    }


@router.get("/transcribe-stream/{session_id}/events")
async def stream_transcribe_events(
    session_id: str,
    stm: StreamTranscribeManager = Depends(get_stream_transcribe_manager),
) -> EventSourceResponse:
    async def event_gen():
        async for evt in stm.stream_events(session_id):
            yield {"event": evt.type, "data": evt.model_dump_json()}

    return EventSourceResponse(event_gen())
