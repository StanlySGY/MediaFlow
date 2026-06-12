from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import media_router, meta_router, router as asr_router
from app.config import get_settings
from app.services.realtime_manager import RealtimeManager
from app.services.stream_manager import TaskManager
from app.services.stream_transcribe_manager import StreamTranscribeManager


WEB_DIR = Path(__file__).parent / "web"

API_DESCRIPTION = """
MediaFlow 已封装好语音识别网关，当前重点给第三方调用两类标准接口。

## 重要接口速览

### 1. 实时录音转文字：上传 base64，SSE 流式返回文字

适用场景：浏览器、App、设备端边录音边把音频片段上传给服务端。

调用顺序：

1. `POST /asr/realtime/session` 创建实时会话，拿到 `session_id`。
2. `GET /asr/realtime/{session_id}/events` 建立 SSE 订阅，接收识别事件。
3. `POST /asr/realtime/{session_id}/audio` 多次上传 base64 音频 chunk。
4. 音频结束时，继续调用 `/audio` 并传 `is_final=true`，或调用
   `POST /asr/realtime/{session_id}/end`。

音频 chunk 请求体核心字段：

- `seq`：客户端递增序号，建议从 1 开始。
- `audio`：base64 编码的音频片段；最后一个结束包可为空字符串。
- `is_final`：是否最后一个包。`true` 表示音频已发完，服务端开始输出最终结果。

SSE 事件类型：

- `online`：中间识别结果。
- `final`：最终识别文本。
- `done`：会话结束。
- `error`：识别失败或上游异常。

当前 Qwen ASR 通过 `realtime_offline` 封装时，底层不是原生实时识别：
服务端会先接收 base64 chunks，结束后调用 Qwen ASR，再用 SSE 模拟流式返回。
事件里的 `mode=simulated_streaming` 表示这种模拟流式模式。后续如果换成原生
realtime ASR，调用方仍然使用同一套接口。

### 2. 上传 WAV 文件转文字：上传文件，SSE 流式返回文字

适用场景：调用方已有完整 WAV 或音视频文件，希望上传后持续接收识别进度和文本。

调用顺序：

1. `POST /asr/file` 使用 `multipart/form-data` 上传文件，字段名固定为 `file`。
2. 从响应中立即读取并保存 `task_id`、`events_url`、`result_url`。
   `task_id` 是本次文件转写任务的唯一主键，也是切页面、断线或稍后查询时找回任务的依据。
3. `GET /asr/file/{task_id}/events` 订阅 SSE，实时接收分片识别结果。
4. `GET /asr/file/{task_id}/result` 获取最终完整 JSON 结果。

文件接口 SSE 事件：

- `event: segment`：单个分片识别结果，`data.task_id` 会随每条分片事件返回，
  便于调用方把事件归属到对应任务；同时包含 `segment_id`、`start`、`end`、`text`。
- `event: done`：任务结束，包含最终任务状态。

注意：不要等第一个 `segment` 才保存 `task_id`。有些文件需要等待切分或上游识别后才会
产生第一条分片事件，失败场景也可能没有分片。可靠做法是在 `POST /asr/file` 成功后立刻
保存响应里的 `task_id`；页面切走、SSE 断开或用户稍后回来时，用这个 `task_id` 重新订阅
`/asr/file/{task_id}/events`，或直接查询 `/asr/file/{task_id}/result`。

## 鉴权说明

如果服务启用了 `ACCESS_TOKENS`，普通 HTTP 请求使用
`Authorization: Bearer <token>`；SSE 场景可使用 `?token=<token>` 查询参数。
"""

# Shown at "/" when the built frontend is absent (e.g. running the backend
# directly without `npm run build`; in Docker the multi-stage build always
# populates app/web, so the SPA is served instead).
_NO_UI_HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>MediaFlow</title><style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f3f5f9;
color:#1c2330;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center}
.box{background:#fff;border:1px solid #e6e9f0;border-radius:16px;padding:40px 44px;max-width:520px;
box-shadow:0 4px 24px rgba(20,30,60,.06)}h1{font-size:18px;margin:0 0 12px}p{color:#4a5263;line-height:1.7;font-size:14px}
code{background:#eef1f6;padding:2px 7px;border-radius:5px;font-family:ui-monospace,monospace;font-size:13px}
a{color:#2f6bff;text-decoration:none}</style></head><body><div class="box">
<h1>🎬 MediaFlow 已启动</h1>
<p>后端接口正常运行，但前端界面尚未构建。</p>
<p>推荐用 Docker 一键部署（镜像会自动构建前端）：<br><code>./build.sh &amp;&amp; docker compose up -d</code></p>
<p>本地开发可在 <code>frontend/</code> 下执行 <code>npm install &amp;&amp; npm run build</code>，或 <code>npm run dev</code> 启动热重载。</p>
<p>接口文档：<a href="/docs">/docs</a></p>
</div></body></html>"""


@asynccontextmanager
async def _lifespan(app: FastAPI):
    await app.state.realtime_manager.start()
    try:
        yield
    finally:
        await app.state.realtime_manager.stop()


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    )

    app = FastAPI(
        title="MediaFlow",
        description=API_DESCRIPTION,
        version="1.4.0",
        lifespan=_lifespan,
    )
    app.state.manager = TaskManager(settings)
    app.state.realtime_manager = RealtimeManager(settings)
    app.state.stream_transcribe_manager = StreamTranscribeManager(settings)
    app.include_router(asr_router)
    app.include_router(media_router)
    app.include_router(meta_router)

    if not settings.asr_api_key:
        logging.getLogger(__name__).warning(
            "ASR_API_KEY is not set — transcription requests will likely fail with 401 unless your ASR endpoint is unauthenticated."
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    if (WEB_DIR / "index.html").is_file():
        app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    else:
        # Fallback root so the app is usable (and testable) without a built frontend.
        @app.get("/", response_class=HTMLResponse)
        async def _root() -> str:
            return _NO_UI_HTML

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    s = get_settings()
    uvicorn.run("app.main:app", host=s.host, port=s.port, log_level=s.log_level)
