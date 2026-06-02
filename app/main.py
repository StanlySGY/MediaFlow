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


WEB_DIR = Path(__file__).parent / "web"

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
        description="Media toolkit: long-audio splitting, streaming ASR, and lossless audio/video concatenation.",
        version="1.4.0",
        lifespan=_lifespan,
    )
    app.state.manager = TaskManager(settings)
    app.state.realtime_manager = RealtimeManager(settings)
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
