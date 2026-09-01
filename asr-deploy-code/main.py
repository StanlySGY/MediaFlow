"""Qwen3-ASR 昇腾 NPU 流式识别服务入口。"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from .config import get_settings
from .engine import ASREngine, set_engine
from .routers import health as health_router
from .routers import http as http_router
from .routers import ws as ws_router
from .version import VERSION

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
        force=True,
    )
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


logger = logging.getLogger("qwen3-asr")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    setup_logging(settings.log_level)

    logger.info("=" * 68)
    logger.info(" Qwen3-ASR Streaming Service (Ascend NPU)  v%s", VERSION)
    logger.info(" model   : %s", settings.model_path)
    logger.info(" device  : %s   dtype: %s", settings.torch_device, settings.dtype)
    logger.info(" backend : %s", settings.backend)
    logger.info(" listen  : %s:%s", settings.host, settings.port)
    logger.info("=" * 68)

    engine = ASREngine(settings)
    set_engine(engine)
    engine.bind_loop()

    async def _load() -> None:
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, engine.load)
            logger.info("服务就绪，可开始接收请求。")
        except Exception:
            logger.exception("模型加载失败，服务将持续返回 503。请检查权重路径与 NPU 环境。")

    # 后台加载：让 /healthz 立刻可用，编排系统用 /readyz 判断何时挂流量
    task = asyncio.create_task(_load())

    if os.getenv("ASR_EAGER_LOAD", "false").lower() in ("1", "true", "yes"):
        await task

    try:
        yield
    finally:
        if not task.done():
            task.cancel()
        engine.unload()
        set_engine(None)
        logger.info("服务已停止。")


def create_app() -> FastAPI:
    settings = get_settings()
    setup_logging(settings.log_level)

    app = FastAPI(
        title="Qwen3-ASR Streaming Service (Ascend NPU)",
        description=(
            "基于 Qwen3-ASR-1.7B 的流式语音识别服务，运行于华为昇腾 NPU。\n\n"
            "- WebSocket 流式：`/v1/asr/stream`\n"
            "- 整段转写（OpenAI 兼容）：`POST /v1/audio/transcriptions`\n"
            "- 浏览器测试页：`/demo`"
        ),
        version=VERSION,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router.router)
    app.include_router(http_router.router)
    app.include_router(ws_router.router)

    @app.get("/", include_in_schema=False)
    async def root():
        return RedirectResponse("/demo")

    @app.get("/demo", include_in_schema=False)
    async def demo():
        index = WEB_DIR / "index.html"
        if index.exists():
            return FileResponse(index, media_type="text/html; charset=utf-8")
        return JSONResponse({"detail": "demo page not bundled"}, status_code=404)

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    s = get_settings()
    uvicorn.run(
        "app.main:app",
        host=s.host,
        port=s.port,
        workers=1,           # 模型常驻显存，多 worker 会重复占用 NPU，务必保持 1
        log_level=s.log_level.lower(),
        ws_ping_interval=20,
        ws_ping_timeout=20,
    )
