# AudioFlow-ASR

长音频切分 + 流式 ASR 转写服务。基于 FastAPI / asyncio / FFmpeg，调用 OpenAI 兼容格式的 ASR 接口（默认阿里云 DashScope 的 Qwen ASR），支持：

- 多格式输入（mp3/wav/m4a/flac/aac/ogg/pcm/mp4/mov/mkv）
- FFmpeg 自动标准化为 16k mono pcm_s16le
- 三种切分策略：`fixed` / `silence`（静音感知）/ `overlap`（重叠切分）
- 多分片 asyncio 并发调用 ASR（信号量限流）
- 服务端 SSE 流式推送每个分片识别结果（多订阅 + 历史回放，刷新页面不丢消息）
- 时间轴感知拼接（ASR 返回 word 级时间戳时按重叠中点裁剪；否则最长公共子串去重）
- SRT / VTT 字幕导出
- 可插拔 ASR Provider 抽象层（默认 OpenAI 兼容，可扩展 FunASR / Whisper / SenseVoice 等）
- 可选 Bearer Token 鉴权（同时支持 `?token=` 用于 SSE）
- 失败分片隔离，自动指数退避重试
- 任务结果持久化到 `outputs/`，进程重启后 `/result` 仍可用
- Docker 一键部署（内置 ffmpeg）
- 内置 Web UI（拖拽上传 + 实时分片进度 + 完整文本/字幕复制下载）

## 快速开始

### 本地运行

```bash
cp .env.example .env
# 编辑 .env，填入 ASR_API_KEY
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

需要本机已安装 `ffmpeg` 与 `ffprobe`。访问 `http://localhost:8000/` 打开 Web UI，`/docs` 查看 API。

### Docker

```bash
cp .env.example .env
docker compose up -d --build
```

## API

> 提交任务后，直接打开根路径 `/` 用 Web UI 查看实时进度也可。下面是程序化调用示例。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/` | Web UI |
| GET  | `/auth/info` | 查询是否启用鉴权（`{auth_required: bool}`） |
| POST | `/asr/task` | `multipart/form-data` 上传音频，返回 `task_id` |
| GET  | `/asr/task/{task_id}` | 任务状态与进度 |
| GET  | `/asr/task/{task_id}/stream` | SSE 流式推送每个分片的识别事件 |
| GET  | `/asr/task/{task_id}/result` | 任务最终 JSON 结果（含 segments、word 时间戳、拼接文本） |
| GET  | `/asr/task/{task_id}/subtitle?format=srt\|vtt` | 字幕下载 |
| GET  | `/health` | 健康检查 |

> 启用鉴权时（`ACCESS_TOKENS=...`），所有 `/asr/*` 请求需附带 `Authorization: Bearer <token>`；SSE 用 `?token=<token>` 查询串。`/`、`/auth/info`、`/health` 不受影响。

### 提交任务

```bash
curl -X POST http://localhost:8000/asr/task \
  -F "file=@long_meeting.mp3"
# => {"task_id": "ab12..."}
```

### 订阅流式结果

```bash
curl -N http://localhost:8000/asr/task/ab12.../stream
# event: segment
# data: {"task_id":"ab12...","segment_id":1,"start":0.0,"end":30.0,"text":"……","is_final":true}
```

### 取最终结果

```bash
curl http://localhost:8000/asr/task/ab12.../result
```

```json
{
  "task_id": "ab12...",
  "status": "done",
  "duration": 3600.0,
  "language": "zh",
  "text": "完整文本……",
  "segments": [
    {"segment_id": 1, "start": 0.0, "end": 30.0, "text": "……", "is_final": true, "error": null}
  ]
}
```

## 配置项

见 `.env.example`。关键项：

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `ASR_PROVIDER` | ASR 后端实现 | `openai_compat` |
| `ASR_BASE_URL` | OpenAI 兼容 ASR 根路径 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `ASR_API_KEY` | API Key | *(必填)* |
| `ASR_MODEL` | 模型名 | `qwen3-asr-flash` |
| `ASR_TIMESTAMPS` | 请求 word 级时间戳（用于时间轴拼接 + 字幕） | `true` |
| `SPLIT_STRATEGY` | `fixed` / `silence` / `overlap` | `silence` |
| `SPLIT_CHUNK_SECONDS` | 分片目标长度 | `30` |
| `SPLIT_OVERLAP_SECONDS` | 重叠秒数（仅 overlap 策略） | `2` |
| `ASR_CONCURRENCY` | 并发分片数 | `4` |
| `ASR_MAX_RETRIES` | 单分片最大重试次数 | `3` |
| `MAX_UPLOAD_BYTES` | 单次上传上限 | 2 GiB |
| `ACCESS_TOKENS` | 逗号分隔的访问令牌，空 = 关闭鉴权 | *(空)* |

## 目录结构

```
app/
├── api/              FastAPI 路由 (含 SSE)
├── services/
│   ├── ffmpeg_service.py    标准化 / 探测时长 / 静音检测 / 精确切片
│   ├── splitter.py          切分策略
│   ├── asr/                 ASR Provider 抽象层
│   │   ├── base.py          ASRProvider / ASRResult / WordTime
│   │   ├── openai_compat.py OpenAI 兼容客户端（DashScope / Whisper / FunASR-shim）
│   │   └── registry.py      provider 注册表（按 ASR_PROVIDER 选择）
│   ├── merger.py            时间轴优先 + LCS 回退的去重拼接
│   ├── subtitles.py         SRT / VTT 字幕生成
│   └── stream_manager.py    任务编排 + 并发执行 + 多订阅事件流 + 持久化
├── security.py              Bearer Token 鉴权（可关）
├── models/schemas.py        数据结构
├── config.py                环境变量
└── main.py                  应用入口
tests/                       核心单元测试
docker-compose.yml           容器编排
Dockerfile                   含 ffmpeg
```

## 测试

```bash
pip install -r requirements-dev.txt
pytest
```

## 扩展 ASR Provider

在 `app/services/asr/` 新建 `xxx.py`，实现 `ASRProvider` 协议，然后用 `@register("xxx")` 装饰一个 factory：

```python
# app/services/asr/funasr.py
from app.services.asr.base import ASRProvider, ASRResult
from app.services.asr.registry import register

class FunASRProvider:
    async def __aenter__(self): ...
    async def __aexit__(self, *exc): ...
    async def transcribe(self, file_path, *, prompt=None) -> ASRResult: ...

@register("funasr")
def _funasr(settings):
    return FunASRProvider(...)
```

然后 `import app.services.asr.funasr` 触发注册（可在 `app/services/asr/__init__.py` 加），并设置 `ASR_PROVIDER=funasr`。

## 进一步可扩展
- **说话人分离**：在 ASR 阶段返回 speaker 标签后合并到 `Word`
- **翻译 / 摘要**：拿到完整文本后接 LLM
- **任务队列**：当前任务在进程内 `asyncio.create_task` 调度；横向扩展可替换为 Celery / RQ + Redis
