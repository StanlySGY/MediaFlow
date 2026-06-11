# MediaFlow

音视频处理工具箱。基于 FastAPI / asyncio / FFmpeg，三大能力合一：长音频切分、流式 ASR 转写（调用 OpenAI 兼容 ASR 接口，默认阿里云 DashScope 的 Qwen ASR）、音视频无损合并。支持：

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
- 内置 Web UI（侧边栏多 tab：文件任务 / 实时识别 / 服务配置 / 历史任务；拖拽上传 + 真实上传进度 + 实时分片进度 + 音视频播放联动校对 + 分片双击校对并前端导出精修字幕 + 完整文本/字幕复制下载 + 配置面板**可在线编辑保存** + 上游连通测试 + 单分片原始响应查看；移动端响应式抽屉布局）
- **音视频无损合并**（`POST /media/concat`：同格式多文件按上传顺序拼接，FFmpeg concat demuxer + `-c copy`，不转码、输出格式 = 输入格式，音频/视频通用）
- **实时识别 pipeline**（POST /asr/realtime/session → POST audio base64 chunks → SSE events → POST end）

## 快速开始

### 本地运行

```bash
cp .env.example .env
# 编辑 .env，填入 ASR_API_KEY
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8999
```

需要本机已安装 `ffmpeg` 与 `ffprobe`。访问 `http://localhost:8999/` 打开 Web UI，`/docs` 查看 API。

> **运行时配置编辑**：UI 顶部「服务配置」面板可直接修改 provider、base URL、API key、模型、热词、切分参数、鉴权令牌等，点保存即时生效，不需重启服务。改动持久化到 `runtime_config.json`，下次启动自动恢复。点击「重置为 .env 默认」可一键清除运行时改动。注意：`runtime_config.json` 是明文且包含 API key / 访问令牌，部署时确保文件权限合理。

### Docker

```bash
cp .env.example .env
docker compose up -d --build
```

部署后访问 `http://<服务器IP>:8999/`（端口由 `.env` 的 `PORT` 决定，默认 8999）。

#### 浏览器打不开 / 端口连不上？

如果容器日志显示 `Uvicorn running` 且 `docker compose ps` 是 `healthy`，但浏览器超时、本机 `curl localhost:8999` 也 reset/refused，多半是 **Docker 的端口转发（iptables/FORWARD）被宿主机防火墙冲掉了**（RHEL/Rocky 的 firewalld、OpenStack/MAAS 节点常见）。

- 有 root：`sudo systemctl restart docker` 重新注入规则即可。
- **没有 root**：改用 host 网络部署，让服务直接绑宿主机端口，绕开 docker 转发：

  ```bash
  docker compose -f docker-compose.host.yml up -d --build
  ```

  外网访问仍需宿主机防火墙放行该端口；若无权限，可把 `.env` 的 `PORT` 改成一个已放行的端口。

### 离线现场部署（air-gapped）

> 📋 给现场运维的完整操作手册见 **[DEPLOY_ONSITE.md](DEPLOY_ONSITE.md)**（部署 / 配置 / 验证 / 排错，可随交付包一起发给现场）。

现场内网无法联网构建或拉取镜像时，在**有网的构建机**上打包好镜像，拷到现场加载运行：

```bash
# 1. 构建机（有网）：构建并导出镜像（默认跟随本机架构；构建机与现场均为 arm64）
./build.sh --save
#    产物：mediaflow-1.4.0-arm64.tar.gz
#    需为别的架构构建（如现场是 x86）：./build.sh --platform linux/amd64 --save（须 buildx + qemu）

# 2. 把 .tar.gz、docker-compose.prod.yml、.env.example 拷到现场（U 盘 / 内网盘）

# 3. 现场服务器（离线）：加载镜像
docker load -i mediaflow-1.4.0-arm64.tar.gz

# 4. 准备配置：ASR_BASE_URL 指向内网已部署的 ASR（无鉴权可留空 ASR_API_KEY）
cp .env.example .env

# 5. 启动（prod compose 只跑现成镜像，绝不在现场构建）
docker compose -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` 刻意不含 `build:`——镜像没加载成功时直接报 `image not found`，而不是悄悄尝试离线构建再失败；它固定引用 `mediaflow:1.4.0`，多次交付时现场版本可追溯。`./outputs`、`./temp` 已挂载为数据卷，更新镜像（重新 `docker load` + recreate）不丢历史结果。

> `docker-compose.prod.yml` 默认用 `network_mode: host`：MAAS/OpenStack、firewalld 节点会丢弃发往 docker bridge 的流量、令发布端口静默失效，host 网络直接绑宿主端口在各类环境都通。外网访问仍需宿主防火墙/安全组放行 8999（`ufw allow 8999/tcp`、`firewall-cmd`、OpenStack 安全组）。普通主机若想要端口隔离，可把 `network_mode: host` 换回 `ports: ["8999:8999"]`。

> ⚠️ **单 worker 运行**：任务状态、SSE 订阅、实时会话都在单进程内存中，请勿给 uvicorn 加 `--workers`，多进程间状态不共享会导致任务与事件错乱。镜像默认即单 worker。

## 对接自部署 ASR

提供两种 OpenAI 兼容协议，按上游服务暴露的端点二选一：

| `ASR_PROVIDER` | 上游端点 | 适用 | Word 时间戳 |
|---|---|---|---|
| `openai_compat` | `POST /v1/audio/transcriptions`（multipart） | OpenAI Whisper、faster-whisper-server、DashScope compat 的 transcriptions、FunASR/SenseVoice OpenAI 网关 | ✅（若上游支持 `timestamp_granularities[]`） |
| `openai_chat_audio` | `POST /v1/chat/completions`（JSON + base64 input_audio） | vLLM Qwen3-ASR-Flash、DashScope compat 的 chat 多模态、任何把音频模型当多模态 LLM 服务的部署 | ❌（拼接自动回落 LCS，字幕按分片粒度） |

判断方法很简单：拿一条 curl 试一下上游：

```bash
# 若 200/OK → openai_compat
curl -X POST $ASR_BASE_URL/audio/transcriptions \
  -F "file=@any.wav" -F "model=$ASR_MODEL" -H "Authorization: Bearer $ASR_API_KEY"

# 若 200/OK → openai_chat_audio（你同事的那条曲线）
DATA_URI="data:audio/wav;base64,$(base64 -w0 any.wav)"
curl -X POST $ASR_BASE_URL/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ASR_API_KEY" \
  -d '{"model":"'$ASR_MODEL'","messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"'$DATA_URI'"}}]}],"asr_options":{"enable_itn":false}}'
```

或者打开 Web UI 顶部的「服务配置」，点「测试连接」——服务端用 1s 静音 WAV 试探当前 provider，返回 200/4xx 直接显示在面板上，不通就切 `ASR_PROVIDER` 再点一次。

### vLLM 跑 Qwen3-ASR

```bash
# .env
ASR_PROVIDER=openai_chat_audio   # vLLM 服务 Qwen3-ASR 的标准方式
ASR_BASE_URL=http://your-vllm-host:8000/v1
ASR_API_KEY=                       # 内网无鉴权可留空
ASR_MODEL=Qwen/Qwen3-ASR-Flash     # 与 vllm serve --served-model-name 对齐
```

热词偏置：`ASR_HOTWORDS=Qwen,vLLM,LoRA` 会拼成 system 消息「热词：Qwen、vLLM、LoRA」一并发出。

### 公网 DashScope Qwen ASR

```bash
ASR_PROVIDER=openai_chat_audio     # 若 Qwen3-ASR-Flash 走 chat 路径
# 或 openai_compat                  # 若上游开了 transcriptions（先 curl 验）
ASR_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ASR_API_KEY=sk-xxx                 # 你的 DashScope key
ASR_MODEL=qwen3-asr-flash
```

### FunASR / SenseVoice / Paraformer 等 OpenAI 兼容网关

同 `openai_compat`：只改 `ASR_BASE_URL` 和 `ASR_MODEL`。若网关不支持 timestamp 选项，把 `ASR_TIMESTAMPS=false`。

### 自部署服务**非** OpenAI 兼容

新建一个 `app/services/asr/yourprovider.py`，实现 `ASRProvider` 协议（`__aenter__` / `__aexit__` / `transcribe`），用 `@register("yourprovider")` 注册，然后 `ASR_PROVIDER=yourprovider`。`stream_manager` / `merger` / 路由层都不需要改动。

## 实时识别 (Realtime)

文件任务以外还有一条独立的 **realtime pipeline**：上层应用按 chunk 推送 base64 音频，服务端持续以 SSE 推回 online/final/done 事件。

```text
POST   /asr/realtime/session            创建会话 → 返回 events/audio/end URL
POST   /asr/realtime/{id}/audio         { seq, audio: base64, is_final }
GET    /asr/realtime/{id}/events        SSE: event=online|final|error|done
POST   /asr/realtime/{id}/end           主动结束
DELETE /asr/realtime/{id}               关闭并释放
```

### Provider 抽象

`RealtimeASRProvider` 协议（`app/services/asr/realtime_base.py`）：

```python
class RealtimeASRProvider(Protocol):
    async def __aenter__(self): ...
    async def __aexit__(self, *exc): ...
    async def start(self, config): ...
    async def push_audio(self, chunk): ...
    async def finish(self): ...
    def events(self): ...      # AsyncIterator[RealtimeASREvent]
```

内置实现：

| `REALTIME_ASR_PROVIDER` | 用途 |
| --- | --- |
| `realtime_mock` | 测试用，按规则产出 online/final/done，无真实模型依赖 |
| `realtime_http` | 通用 HTTP+SSE 客户端，对接「标准下层 ASR 服务」 |

**标准下层 ASR 协议**（下层模型方需实现）：

```text
POST   {base}/session                   → { "session_id": "..." }
POST   {base}/session/{id}/audio        body: { seq, audio, is_final }
GET    {base}/session/{id}/events       SSE: event=online|final|error|done
POST   {base}/session/{id}/end
```

非标准 WebSocket 模型（如 FunASR runtime）**不要**直接接入 MediaFlow；先在模型服务旁边做一个 shim 把它包成上面这套 HTTP+SSE 协议，再让 `realtime_http` 对接 shim。

### curl 示例

```bash
# 1. 创建会话
SID=$(curl -sX POST http://localhost:8999/asr/realtime/session \
  -H "Content-Type: application/json" \
  -d '{"sample_rate":16000,"format":"pcm_s16le","channels":1,"language":"zh"}' \
  | python -c "import json,sys; print(json.load(sys.stdin)['session_id'])")
echo "session: $SID"

# 2. 订阅 SSE（另起终端）
curl -N http://localhost:8999/asr/realtime/$SID/events

# 3. 推 chunk（base64 编码的 PCM 数据）
curl -X POST http://localhost:8999/asr/realtime/$SID/audio \
  -H "Content-Type: application/json" \
  -d '{"seq":1,"audio":"AAAAAAAAAAAAAAAA","is_final":false}'

# 4. 结束
curl -X POST http://localhost:8999/asr/realtime/$SID/end

# 5. 或直接发空 chunk + is_final=true 也行
curl -X POST http://localhost:8999/asr/realtime/$SID/audio \
  -H "Content-Type: application/json" \
  -d '{"seq":99,"audio":"","is_final":true}'
```

### 浏览器 EventSource 示例

```js
const r = await fetch('/asr/realtime/session', {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({sample_rate: 16000, format: 'pcm_s16le', channels: 1}),
});
const { session_id } = await r.json();

const es = new EventSource(`/asr/realtime/${session_id}/events`);
es.addEventListener('online', e => console.log('partial:', JSON.parse(e.data).text));
es.addEventListener('final',  e => console.log('final:',   JSON.parse(e.data).text));
es.addEventListener('done',   e => { console.log('done'); es.close(); });

async function pushChunk(b64, isFinal=false) {
  await fetch(`/asr/realtime/${session_id}/audio`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({seq: ++seq, audio: b64, is_final: isFinal}),
  });
}
```

### 音频格式约定

建议 PCM s16le mono 16kHz（chunks 之间无重叠）。其他格式（带 wav header 的整段 wav、webm/opus 等）也能跑通，但下层 provider 自己负责解码——只对 `realtime_mock` 来说音频内容不参与识别。

### Web UI

打开 `/` 后切到「实时识别」tab：
1. 填会话参数 → 创建会话（自动订阅 SSE）
2. 选本地音频文件 → 设 chunk 大小 + 发送间隔 → 点「开始发送」
3. 事件流面板里看 online/final/done 实时滚动；右上角统计 chunks/bytes/events
4. 也可以手动粘贴一段 base64 单包测试，或直接点「发送 end」

## 音视频合并 (Concat)

把多段**同格式**音频或视频按上传顺序无损拼接成一个长文件：走 FFmpeg concat demuxer + `-c copy`，不转码、不重编码——输出格式与输入一致，耗时只受磁盘 IO 限制。

所有输入需共用同一容器 / 编码 / 采样率 / 分辨率等参数（同一设备录制的连续片段天然满足）；参数不一致时 FFmpeg 报错，接口返回 400。混格式或少于 2 个文件同样返回 400。

```bash
# 音频：多段录音拼成一条
curl -X POST http://localhost:8999/media/concat \
  -F "files=@part1.mp3" -F "files=@part2.mp3" -F "files=@part3.mp3" \
  -o merged.mp3

# 视频：同编码的多段 mp4 无损拼接（秒级）
curl -X POST http://localhost:8999/media/concat \
  -F "files=@clip1.mp4" -F "files=@clip2.mp4" \
  -o merged.mp4
```

## API

> 提交任务后，直接打开根路径 `/` 用 Web UI 查看实时进度也可。下面是程序化调用示例。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/` | Web UI |
| GET  | `/auth/info` | 查询是否启用鉴权（`{auth_required: bool}`） |
| GET  | `/asr/config` | 当前生效配置（不含 API key / access tokens 明文，只暴露 `*_set` / `*_count`） |
| POST | `/asr/config` | 更新运行时配置（白名单字段）；自动持久化到 `runtime_config.json`，**不需重启** |
| POST | `/asr/config/reset` | 清除运行时改动，所有白名单字段回到 `.env` 默认 |
| POST | `/asr/ping` | 用 1s 静音 WAV 试探上游 ASR |
| POST | `/asr/task` | `multipart/form-data` 上传音频，返回 `task_id`。可选覆盖字段：`model`、`language`、`split_strategy`、`chunk_seconds`、`overlap_seconds`、`hotwords`、`prompt_hints`、`timestamps`，仅作用于本次任务 |
| GET  | `/asr/task/{task_id}` | 任务状态与进度 |
| GET  | `/asr/task/{task_id}/stream` | SSE 流式推送每个分片的识别事件（含 `elapsed_ms`） |
| GET  | `/asr/task/{task_id}/result` | 任务最终 JSON 结果（含 segments、word 时间戳、每片耗时与上游 raw） |
| GET  | `/asr/task/{task_id}/segments/{segment_id}/raw` | 单个分片的 ASR 原始返回（调试用） |
| GET  | `/asr/task/{task_id}/subtitle?format=srt\|vtt` | 字幕下载 |
| GET  | `/asr/tasks` | 历史任务列表（内存中 + outputs/ 持久化） |
| POST | `/asr/realtime/session` | 创建实时会话（body：`RealtimeSessionCreate`） |
| GET  | `/asr/realtime/sessions` | 当前活跃会话与可用 realtime providers |
| GET  | `/asr/realtime/{session_id}` | 单个会话状态 |
| POST | `/asr/realtime/{session_id}/audio` | 推送 base64 音频 chunk |
| GET  | `/asr/realtime/{session_id}/events` | SSE 持续推送 online/final/done/error |
| POST | `/asr/realtime/{session_id}/end` | 结束会话 |
| DELETE | `/asr/realtime/{session_id}` | 删除会话 |
| POST | `/media/concat` | `multipart/form-data` 上传 ≥2 个**同格式**音/视频文件，按上传顺序无损拼接（`-c copy`），返回合并文件；混格式 / 单文件 → 400 |
| GET  | `/health` | 健康检查 |

> 启用鉴权时（`ACCESS_TOKENS=...`），所有 `/asr/*`、`/media/*` 请求需附带 `Authorization: Bearer <token>`；SSE 用 `?token=<token>` 查询串。`/`、`/auth/info`、`/health` 不受影响。

### 提交任务

```bash
curl -X POST http://localhost:8999/asr/task \
  -F "file=@long_meeting.mp3"
# => {"task_id": "ab12..."}
```

### 订阅流式结果

```bash
curl -N http://localhost:8999/asr/task/ab12.../stream
# event: segment
# data: {"task_id":"ab12...","segment_id":1,"start":0.0,"end":30.0,"text":"……","is_final":true}
```

### 取最终结果

```bash
curl http://localhost:8999/asr/task/ab12.../result
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
| `ASR_HOTWORDS` | 热词偏置，逗号分隔（拼到 OpenAI `prompt` 字段一并发出） | *(空 = 关)* |
| `ASR_PROMPT_HINTS` | 自由文本上下文提示（同上拼接） | *(空 = 关)* |
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
├── api/              FastAPI 路由 (含 SSE / realtime / media concat)
├── services/
│   ├── ffmpeg_service.py    标准化 / 探测时长 / 静音检测 / 精确切片 / 无损合并
│   ├── splitter.py          切分策略
│   ├── asr/                 ASR Provider 抽象层
│   │   ├── base.py          ASRProvider / ASRResult / WordTime
│   │   ├── openai_compat.py OpenAI 兼容 /audio/transcriptions 客户端
│   │   ├── openai_chat_audio.py OpenAI 兼容 /chat/completions 客户端
│   │   ├── realtime_base.py     RealtimeASRProvider 协议
│   │   ├── realtime_mock.py     测试用 mock realtime provider
│   │   ├── realtime_http.py     标准下层 HTTP+SSE realtime provider
│   │   ├── realtime_registry.py realtime provider 注册表
│   │   └── registry.py      batch provider 注册表
│   ├── merger.py            时间轴优先 + LCS 回退的去重拼接
│   ├── subtitles.py         SRT / VTT 字幕生成
│   ├── stream_manager.py    文件任务编排 + 持久化
│   └── realtime_manager.py  实时会话编排 + 事件流 fan-out
├── security.py              Bearer Token 鉴权（可关）
├── models/schemas.py        数据结构（含 Realtime*）
├── config.py                环境变量 + 运行时配置叠加
├── web/index.html           侧边栏多 tab Web UI
└── main.py                  应用入口（含 lifespan 启停 realtime pump）
tests/                       核心单元测试 + realtime 测试
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

## License

[MIT](LICENSE) © 2026 shigy
