# MediaFlow

[![CI](https://github.com/StanlySGY/MediaFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/StanlySGY/MediaFlow/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/StanlySGY/MediaFlow)](https://github.com/StanlySGY/MediaFlow/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**中文 · [English](README.en.md)**

| 文件转写：上传 → 分片进度 → 双击校对 → 字幕导出 | 实时识别：partial 流式增长 → final |
| --- | --- |
| ![文件转写流程](docs/screenshots/file-flow.gif) | ![实时识别](docs/screenshots/realtime.gif) |

| 服务配置 / 上游连通 | 历史任务 | 单个分片的上游原始响应 |
| --- | --- | --- |
| ![服务配置](docs/screenshots/monitor.png) | ![历史任务](docs/screenshots/history.png) | ![原始响应](docs/screenshots/raw-response.png) |

> 截图中的 ASR 地址已改写为 `asr.internal`，不含真实内网 IP。手机端布局见 [`docs/screenshots/mobile.png`](docs/screenshots/mobile.png)。

音视频处理工具箱。基于 FastAPI / asyncio / FFmpeg，三大能力合一：长音频切分、流式 ASR 转写（调用 OpenAI 兼容 ASR 接口，默认阿里云 DashScope 的 Qwen ASR）、音视频无损合并。**本项目不自带 ASR 模型**，识别由你已有的上游服务完成，能力边界见下表。

- 多格式输入（mp3/wav/m4a/flac/aac/ogg/pcm/mp4/mov/mkv）
- FFmpeg 自动标准化为 16k mono pcm_s16le
- 三种切分策略：`fixed` / `silence`（静音感知）/ `overlap`（重叠切分）
- 多分片 asyncio 并发调用 ASR（信号量限流）
- 服务端 SSE 流式推送每个分片识别结果（多订阅 + 历史回放，刷新页面不丢消息）
- 时间轴感知拼接（ASR 返回 word 级时间戳时按重叠中点裁剪；否则最长公共子串去重）
- SRT / VTT 字幕导出
- 可插拔 ASR Provider 抽象层（默认 OpenAI 兼容，可扩展 FunASR / Whisper / SenseVoice 等）
- 可选 Bearer Token 鉴权（浏览器 SSE 使用短期 HttpOnly cookie，兼容 `?token=`）
- 失败分片隔离，自动指数退避重试
- 任务结果持久化到 `outputs/`，进程重启后 `/result` 仍可用
- Docker 一键部署（内置 ffmpeg）
- 内置 Web UI（侧边栏多 tab：文件任务 / 实时识别 / 服务配置 / 历史任务；拖拽上传 + 真实上传进度 + 实时分片进度 + 音视频播放联动校对 + 分片双击校对并前端导出精修字幕 + 完整文本/字幕复制下载 + 配置面板**可在线编辑保存** + 上游连通测试 + 单分片原始响应查看；移动端响应式抽屉布局）
- **音视频无损合并**（`POST /media/concat`：同格式多文件按上传顺序拼接，FFmpeg concat demuxer + `-c copy`，不转码、输出格式 = 输入格式，音频/视频通用）
- **实时识别 pipeline**（POST /asr/realtime/session → POST audio base64 chunks → SSE events → POST end）

## 能力边界

先看这张表，再决定要不要用：

| 能力 | 本项目 | 说明 |
| --- | --- | --- |
| ASR 模型 / 权重 | ❌ **不含任何模型** | MediaFlow 只发 HTTP 请求。识别质量 = 你的上游模型质量，必须自备 DashScope / vLLM / FunASR / 自建 faster-whisper 网关 |
| 长音频切分 | ✅ | `fixed` / `silence` / `overlap`，纯 FFmpeg |
| 分片结果拼接 | ✅ | 上游给 word 时间戳 → 按重叠中点裁剪；否则最长公共子串去重 |
| Word 级时间戳 | ⚠️ 取决于上游 | 只在上游真的返回 `words[]` 时成立，见下 |
| 字幕粒度 | ⚠️ 随上游降级 | `words` 非空 → 按长度/时长/停顿重新断行；`words` 为空 → **每个分片一条字幕** |
| 说话人分离 diarization | ❌ **由上游负责** | 本项目不含 diarization 模型，也不做声纹聚类。上游不输出 speaker，就不会出现 speaker |
| 标点 / 翻译 / 说话人命名 | ❌ | 需要上游能力或后处理 |
| 实时端点检测（endpointing） | ⚠️ 取决于 provider | `realtime_ws` / `realtime_http` 由上游实时服务决定；`realtime_offline` 是「录完再整段转写」，不是流式 |
| 水平扩展 | ❌ 单进程 | 任务状态 / SSE 订阅 / 实时会话都在进程内存，禁止 `--workers` |

关于 diarization 的具体行为，按 provider 分列：

| Provider | 上游 speaker 标签的去向 |
| --- | --- |
| `openai_compat` | **不解析** `verbose_json.segments[].speaker`。只读顶层 `text` 与 `words[]`；speaker 只出现在 `/asr/task/{id}/segments/{id}/raw` 的原始响应里，不会进入字幕 |
| `openai_chat_audio` | 解析 `segments[].speaker` / `speaker_id`，以及文本里的 `[SPEAKER_00]` 类标签，写进 `words[].speaker`；字幕在 speaker 变化处换行并带上 `[说话人]` |
| `realtime_offline` | 整段转写后按 speaker 分组输出文本 |

要真的拿到说话人分离，请在**上游侧**开启：OpenAI `response_format=diarized_json` + `model=gpt-4o-transcribe-diarize`；faster-whisper 系自建网关的 `WHISPER_DIARIZATION=1`；FunASR 的 `moss-transcribe-diarize`。MediaFlow 侧只需把 `ASR_MODEL` 换成对应模型名。

## 快速开始

### 本地运行

```bash
cp .env.example .env
# 编辑 .env，填入 ASR_API_KEY
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8999
```

需要本机已安装 `ffmpeg` 与 `ffprobe`。访问 `http://localhost:8999/` 打开 Web UI，`/docs` 查看 API。

> **运行时配置编辑**：UI 顶部「服务配置」面板可直接修改 provider、base URL、API key、模型、热词、切分参数、鉴权令牌等，点保存即时生效，不需重启服务。改动持久化到 `config/runtime_config.json`（容器里挂载为 `/app/config`），重建容器后仍在，下次启动自动恢复。点击「重置为 .env 默认」可一键清除运行时改动。该文件可能包含 API key / 访问令牌，服务会在写入后将其权限收紧为仅文件所有者可读写（`0600`）；部署时仍不要把该文件提交到 Git 或暴露给其他用户。

### Docker

```bash
cp .env.example .env
docker compose up -d --build
```

默认只发布到宿主机 loopback，部署后在本机访问 `http://localhost:8999/`（端口由 `.env` 的 `PORT` 决定，默认 8999）。

已有部署的 `.env` 不会因升级而自动覆盖；从旧版样例升级时，请检查 `HOST` 是否仍为 `0.0.0.0`。仅本机使用时改为 `127.0.0.1`；确需远程访问时，先配置令牌再按下文显式开放。

需要从其他机器访问时，先在 `.env` 设置强随机 `ACCESS_TOKENS`（可用 `openssl rand -hex 32` 生成），再按部署方式显式开放网络：普通 Compose 将端口发布改为 `"8999:8999"`；host-network 部署将 `HOST` 改为 `0.0.0.0`。同时配置宿主机防火墙/安全组。不要在未启用令牌时对外开放服务。

#### 浏览器打不开 / 端口连不上？

如果容器日志显示 `Uvicorn running` 且 `docker compose ps` 是 `healthy`，但浏览器超时、本机 `curl localhost:8999` 也 reset/refused，多半是 **Docker 的端口转发（iptables/FORWARD）被宿主机防火墙冲掉了**（RHEL/Rocky 的 firewalld、OpenStack/MAAS 节点常见）。

- 有 root：`sudo systemctl restart docker` 重新注入规则即可。
- **没有 root**：改用 host 网络部署，让服务直接绑宿主机端口，绕开 docker 转发：

  ```bash
  docker compose -f docker-compose.host.yml up -d --build
  ```

  host-network 模式仍遵循 `.env` 的 `HOST`：样例配置只绑定 loopback。远程访问前须设置 `ACCESS_TOKENS`，然后将 `HOST` 改为 `0.0.0.0` 并配置防火墙/安全组。

### 离线现场部署（air-gapped）

> 📋 给现场运维的完整操作手册见 **[DEPLOY_ONSITE.md](DEPLOY_ONSITE.md)**（部署 / 配置 / 验证 / 排错，可随交付包一起发给现场）。

现场内网无法联网构建或拉取镜像时，在**有网的构建机**上打包好镜像，拷到现场加载运行：

```bash
# 1. 构建机（有网）：构建并导出镜像（默认跟随本机架构；构建机与现场均为 arm64）
./build.sh --save
#    产物：mediaflow-1.8.1-arm64.tar.gz
#    需为别的架构构建（如现场是 x86）：./build.sh --platform linux/amd64 --save（须 buildx + qemu）

# 2. 把 .tar.gz、docker-compose.prod.yml、.env.example 拷到现场（U 盘 / 内网盘）

# 3. 现场服务器（离线）：加载镜像
docker load -i mediaflow-1.8.1-arm64.tar.gz

# 4. 准备配置：ASR_BASE_URL 指向内网已部署的 ASR（无鉴权可留空 ASR_API_KEY）
cp .env.example .env

# 5. 启动（prod compose 只跑现成镜像，绝不在现场构建）
docker compose -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` 刻意不含 `build:`——镜像没加载成功时直接报 `image not found`，而不是悄悄尝试离线构建再失败；它固定引用 `mediaflow:1.8.1`，多次交付时现场版本可追溯。`./outputs`、`./temp`、`./config` 已挂载为数据卷，更新镜像（重新 `docker load` + recreate）不丢历史结果，页面上保存的接入配置和密钥也留在宿主机的 `./config` 里。

> `docker-compose.prod.yml` 默认用 `network_mode: host` 以绕开部分主机的 Docker bridge 转发问题，但 `.env.example` 将 `HOST` 设为 `127.0.0.1`。远程访问必须先设置 `ACCESS_TOKENS`，再将 `HOST` 改为 `0.0.0.0` 并放行宿主防火墙/安全组。普通 Docker 主机可改用 bridge 网络；默认端口映射应保留 loopback，远程发布也必须先启用令牌。

> ⚠️ **单 worker 运行**：任务状态、SSE 订阅、实时会话都在单进程内存中，请勿给 uvicorn 加 `--workers`，多进程间状态不共享会导致任务与事件错乱。镜像默认即单 worker，`/metrics` 与调用监控也只反映本进程。收到 SIGTERM 时会先等待最多 8 秒让实时会话收尾、任务在阶段边界停下，超时未完成的任务在下次启动时标记为 `interrupted`。

> ⚠️ **数据卷属主（1.8.0 起）**：镜像以非 root（uid `10001`）运行，`./temp`、`./outputs`、`./config` 是宿主机的 bind mount。首次部署或从旧版本升级前执行一次：
> `mkdir -p temp outputs config && sudo chown -R 10001:10001 temp outputs config`
> 否则容器**会在启动时直接退出**（非 0 退出码，`docker logs` 可见）：启动日志逐条指名哪个路径不可写并打印这条命令。

## 对接自部署 ASR

提供两种 OpenAI 兼容协议，按上游服务暴露的端点二选一：

| `ASR_PROVIDER` | 上游端点 | 适用 | Word 时间戳 | 上游给出 speaker 时 |
|---|---|---|---|---|
| `openai_compat` | `POST /v1/audio/transcriptions`（multipart） | OpenAI 官方接口、自建 faster-whisper OpenAI 网关（如 scribecrate）、DashScope compat 的 transcriptions、FunASR `funasr-server` | ✅（若上游支持 `timestamp_granularities[]`） | ❌ 只读 `text` / `words`，`segments[].speaker` 留在 raw 响应里，不进字幕 |
| `openai_chat_audio` | `POST /v1/chat/completions`（JSON + base64 input_audio） | vLLM Qwen3-ASR-Flash、DashScope compat 的 chat 多模态、任何把音频模型当多模态 LLM 服务的部署 | ⚠️ 仅当上游额外返回 `segments[]` | ✅ 解析 `segments[].speaker` 与文本里的 `[SPEAKER_00]` 标签 |

> 名字里带 faster-whisper 的服务**不一定**是 OpenAI 兼容的：常见的 `ayutaz/faster-whisper-server` 只暴露 `GET/POST /transcribe`，用 `ASR_PROVIDER=openai_compat` 一定 404。这类上游要么自己加一层 OpenAI 兼容 shim，要么写一个自定义 provider（见「自部署服务**非** OpenAI 兼容」）。

判断方法很简单：拿一条 curl 试一下上游：

```bash
# 若 200/OK → openai_compat
curl -X POST $ASR_BASE_URL/audio/transcriptions \
  -F "file=@any.wav" -F "model=$ASR_MODEL" -H "Authorization: Bearer $ASR_API_KEY"

# 若 200/OK → openai_chat_audio（你同事的那条曲线）
DATA_URI="data:audio/wav;base64,$(base64 -w0 any.wav)"
curl -X POST $ASR_BASE_URL/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ASR_API_KEY" \
  -d '{"model":"'$ASR_MODEL'","messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"'$DATA_URI'"}}]}]}'
```

或者打开 Web UI 顶部的「服务配置」，点「测试连接」——服务端用 1s 静音 WAV 试探当前 provider，返回 200/4xx 直接显示在面板上，不通就切 `ASR_PROVIDER` 再点一次。

### 已有上游：3 分钟接通

上游已经在跑，你只需要 4 行 `.env`。先用上面两条 curl 定下 `ASR_PROVIDER`，再按下面三选一填。

**A. faster-whisper 系自建 OpenAI 网关**（OpenAI 官方接口同理）

```bash
ASR_PROVIDER=openai_compat
ASR_BASE_URL=http://127.0.0.1:8000/v1
ASR_MODEL=whisper-large-v3
ASR_TIMESTAMPS=true
```

时间戳有没有真的回来，用一条 curl 判定，别猜：

```bash
curl -sX POST $ASR_BASE_URL/audio/transcriptions   -F "file=@any.wav" -F "model=$ASR_MODEL"   -F "response_format=verbose_json" -F "timestamp_granularities[]=word" | head -c 400
```

顶层出现 `"words":[{...}]` → 保持 `ASR_TIMESTAMPS=true`；上游对 `timestamp_granularities[]` 报 400 或 `words` 为空 → 改 `ASR_TIMESTAMPS=false`（省一次无谓的失败重试）。
diarization 在上游侧开 `WHISPER_DIARIZATION=1`，speaker 写进 `verbose_json.segments[].speaker`；`openai_compat` 不解析它，见「能力边界」。

**B. FunASR（SenseVoice / Paraformer）**

```bash
# 上游侧：funasr-server --host 0.0.0.0 --port 8000 --model sensevoice --device cuda:0
ASR_PROVIDER=openai_compat
ASR_BASE_URL=http://127.0.0.1:8000/v1
ASR_MODEL=sensevoice
ASR_TIMESTAMPS=false     # 该网关的 multipart 只有 file/model/language/response_format，没有 timestamp_granularities
```

`ASR_TIMESTAMPS=false` 在这里是正确配置而不是降级妥协：字段不存在，留着只会让部分构建报错。代价是字幕退化成每个分片一条。要 speaker：上游换成 `funasr-server --model moss-transcribe-diarize`，并请求 `response_format=verbose_json`。

**C. vLLM 服务 Qwen3-ASR**

```bash
# 上游侧：vllm serve /models/Qwen3-ASR-Flash --served-model-name qwen3-asr --port 8000
ASR_PROVIDER=openai_chat_audio
ASR_BASE_URL=http://127.0.0.1:8000/v1
ASR_MODEL=qwen3-asr        # 必须与 --served-model-name 一致
ASR_TIMESTAMPS=false
```

`vllm serve` 的音频入口只能收完整音频再返回结果，不做流式；实时页要么用 `realtime_offline`（录完整段再整篇转写），要么另接实时 ASR 上游。

**接通后的 30 秒验收**

```bash
curl -sX POST http://localhost:8999/asr/ping                 # 上游是否可达
curl -sX POST http://localhost:8999/asr/file -F "file=@any.wav"
curl -N http://localhost:8999/asr/file/<task_id>/events
curl -s  http://localhost:8999/asr/file/<task_id>/result | head -c 600
```

判据：`result.segments[].words` 非空 → 时间轴感知拼接 + 细粒度字幕；为空 → 最长公共子串去重 + 分片粒度字幕。**这是预期行为，不是 bug**，除非你的上游本来就该返回 word 时间戳。

> 上游协议依据（2026-10 逐条核对）：OpenAI 转写接口的 `response_format` / `timestamp_granularities[]` 与 `verbose_json.words[]` [OpenAI, API Reference, Audio transcriptions]；`hwdsl2/scribecrate` README（`WHISPER_DIARIZATION`、`timestamp_granularities[]` 默认 `["segment"]`、仅 OpenAI 支持的 diarize 选项对本网关返回 400）；`modelscope/FunASR` `examples/openai_api/OPENAPI.md`（multipart 字段表、`moss-transcribe-diarize`）；`ayutaz/faster-whisper-server` README（仅 `/transcribe`）。

### vLLM 跑 Qwen3-ASR

```bash
# .env
ASR_PROVIDER=openai_chat_audio   # vLLM 服务 Qwen3-ASR 的标准方式
ASR_BASE_URL=http://your-vllm-host:8000/v1
ASR_API_KEY=                       # 内网无鉴权可留空
ASR_MODEL=Qwen/Qwen3-ASR-Flash     # 与 vllm serve --served-model-name 对齐
```

`openai_chat_audio` 按 DashScope/Qwen3-ASR 的 ASR 专用任务格式只发送 `input_audio`；热词、上下文提示和语言不会拼成 system 消息。

### 公网 DashScope Qwen ASR

```bash
ASR_PROVIDER=openai_chat_audio     # 若 Qwen3-ASR-Flash 走 chat 路径
# 或 openai_compat                  # 若上游开了 transcriptions（先 curl 验）
ASR_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ASR_API_KEY=sk-xxx                 # 你的 DashScope key
ASR_MODEL=qwen3-asr-flash
```

### FunASR / SenseVoice / Paraformer 等 OpenAI 兼容网关

上游侧：

```bash
pip install funasr
funasr-server --host 0.0.0.0 --port 8000 --model sensevoice --device cuda:0
curl -s http://127.0.0.1:8000/v1/models      # 看当前加载了哪些模型与别名
```

MediaFlow 侧同 `openai_compat`：只改 `ASR_BASE_URL` 和 `ASR_MODEL`，并把 `ASR_TIMESTAMPS=false`（该网关的 multipart 只接受 `file` / `model` / `language` / `response_format`）。需要 speaker 就换 `--model moss-transcribe-diarize`，`openai_chat_audio` 不适用，仍走 `openai_compat`。

> FunASR 自带的 CLI `funasr audio.wav --spk --timestamps -f json` 用的是 CAM++ 等 VAD 说话人 id，官方文档注明这不是模型原生的 speaker 输出；走 OpenAI 兼容网关时同理，把 speaker 当上游给出的近似标签看待。

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
| `realtime_ws` | 直连 Qwen3-ASR `/v1/asr/stream`；WebM 经 FFmpeg 转为 16k PCM，实时返回 partial/final |
| `realtime_offline` | 把离线文件 ASR 包成实时接口：接收 base64 chunks，结束后调用 `ASR_PROVIDER`，再以 SSE 模拟 online/final/done |

**标准下层 ASR 协议**（下层模型方需实现）：

```text
POST   {base}/session                   → { "session_id": "..." }
POST   {base}/session/{id}/audio        body: { seq, audio, is_final }
GET    {base}/session/{id}/events       SSE: event=online|final|error|done
POST   {base}/session/{id}/end
```

Qwen3-ASR 原生 WebSocket 可直接使用 `realtime_ws`：

```env
REALTIME_ASR_PROVIDER=realtime_ws
REALTIME_ASR_BASE_URL=ws://<服务器IP>:8022/v1/asr/stream
REALTIME_ASR_API_KEY=
```

浏览器应使用同一个 `MediaRecorder` 连续产生 WebM/Opus chunks，并按 `seq` 串行上传。
MediaFlow 会为每个会话启动常驻 FFmpeg，将 WebM 转为服务所需的 16kHz、16bit、单声道 PCM。
其他非标准 WebSocket 协议仍需实现独立 provider，或先用 shim 转成上述 HTTP+SSE 协议。

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

建议浏览器使用连续 WebM/Opus chunks，或直接上传 PCM s16le mono 16kHz（chunks 之间无重叠）。`realtime_ws` 会把 WebM/Opus 实时转换为 200ms PCM 帧；`realtime_offline` 会在结束后把完整录音转成 WAV 并调用文件 ASR。只对 `realtime_mock` 来说音频内容不参与识别。

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
| POST | `/asr/config` | 更新运行时配置（白名单字段）；自动持久化到 `config/runtime_config.json`，**不需重启** |
| POST | `/asr/config/reset` | 清除运行时改动，所有白名单字段回到 `.env` 默认 |
| POST | `/asr/ping` | 用 1s 静音 WAV 试探上游 ASR |
| POST | `/asr/file` | **标准文件 ASR 入口**：`multipart/form-data` 上传 WAV/音视频文件，返回 `task_id` 与 `status_url`、`events_url`、`result_url`（调用方不必自己拼 URL）。可选覆盖字段：`model`、`language`、`split_strategy`、`chunk_seconds`、`overlap_seconds`、`hotwords`、`prompt_hints`、`timestamps`，仅作用于本次任务 |
| GET  | `/asr/file/{task_id}` | 任务状态与进度 |
| GET  | `/asr/file/{task_id}/events` | SSE 流式推送每个分片的识别事件（含 `elapsed_ms`） |
| GET  | `/asr/file/{task_id}/result` | 任务最终 JSON 结果（含 segments、word 时间戳、每片耗时与上游 raw） |
| GET  | `/asr/file/{task_id}/subtitle?format=srt\|vtt` | 字幕下载 |
| POST | `/asr/task` | 已废弃：与 `POST /asr/file` 是同一个任务，只是不返回 `*_url` 字段。新调用方请用 `/asr/file` |
| GET  | `/asr/task/{task_id}` | 已废弃：同 `GET /asr/file/{task_id}` |
| GET  | `/asr/task/{task_id}/stream` | 已废弃：同 `GET /asr/file/{task_id}/events` |
| GET  | `/asr/task/{task_id}/result` | 已废弃：同 `GET /asr/file/{task_id}/result` |
| GET  | `/asr/task/{task_id}/subtitle?format=srt\|vtt` | 已废弃：同 `GET /asr/file/{task_id}/subtitle` |
| GET  | `/asr/task/{task_id}/segments/{segment_id}/raw` | 单个分片的 ASR 原始返回（调试用）。**只有 `/task` 拼写**，`/asr/file` 侧无对应路径 |
| GET  | `/asr/tasks` | 历史任务。查询参数：`q`、`status`（queued/processing/done/failed/cancelled）、`since`、`until`（unix 秒）、`offset`、`limit` |
| POST | `/asr/task/{task_id}/cancel` | 取消尚未完成的文件任务（阶段之间生效，不自动续跑）。**只有 `/task` 拼写** |
| DELETE | `/asr/task/{task_id}` | 删除已结束的历史任务。进行中返回 409。**只有 `/task` 拼写** |
| GET  | `/metrics` | Prometheus 文本指标（启用 `ACCESS_TOKENS` 时需令牌） |
| POST | `/asr/realtime/session` | 创建实时会话（body：`RealtimeSessionCreate`） |
| GET  | `/asr/realtime/sessions` | 当前活跃会话与可用 realtime providers |
| GET  | `/asr/realtime/{session_id}` | 单个会话状态 |
| POST | `/asr/realtime/{session_id}/audio` | 推送 base64 音频 chunk |
| GET  | `/asr/realtime/{session_id}/events` | SSE 持续推送 online/final/done/error |
| POST | `/asr/realtime/{session_id}/end` | 结束会话 |
| DELETE | `/asr/realtime/{session_id}` | 删除会话 |
| POST | `/media/concat` | `multipart/form-data` 上传 ≥2 个**同格式**音/视频文件，按上传顺序无损拼接（`-c copy`），返回合并文件；混格式 / 单文件 → 400 |
| GET  | `/health` | 健康检查 |

> 启用鉴权时（`ACCESS_TOKENS=...`），普通 `/asr/*`、`/media/*`、`/metrics`、`/docs`、`/openapi.json` 请求需附带 `Authorization: Bearer <token>`。成功请求会签发短期 HttpOnly cookie，浏览器 `EventSource` 直接连接 SSE 地址即可，不要把长期 token 放入 URL。命令行客户端仍兼容 `?token=<token>`，但查询串可能进入访问日志。`/`、`/auth/info`、`/health` 不受影响。
>
> `/docs` 与 `/openapi.json` 也接受 `?token=` 与上述 cookie：浏览器顶层导航无法附加 `Authorization`，而 Swagger UI 随后取 schema 用的是同源 cookie。

### 标准文件转写

```bash
curl -X POST http://localhost:8999/asr/file \
  -F "file=@long_meeting.wav"
# => {"task_id":"ab12...","events_url":"/asr/file/ab12.../events","result_url":"/asr/file/ab12.../result"}
```

### 订阅流式结果

```bash
curl -N http://localhost:8999/asr/file/ab12.../events
# event: segment
# data: {"task_id":"ab12...","segment_id":1,"start":0.0,"end":30.0,"text":"……","is_final":true}
```

### 取最终结果

```bash
curl http://localhost:8999/asr/file/ab12.../result
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
| `ASR_HOTWORDS` | 热词偏置，逗号分隔；`openai_compat` 会拼到 OpenAI `prompt` 字段，`openai_chat_audio` 不发送 | *(空 = 关)* |
| `ASR_PROMPT_HINTS` | 自由文本上下文提示；`openai_compat` 会拼到 OpenAI `prompt` 字段，`openai_chat_audio` 不发送 | *(空 = 关)* |
| `SPLIT_STRATEGY` | `fixed` / `silence` / `overlap` | `silence` |
| `SPLIT_CHUNK_SECONDS` | 分片目标长度 | `30` |
| `SPLIT_OVERLAP_SECONDS` | 重叠秒数（仅 overlap 策略） | `2` |
| `ASR_CONCURRENCY` | 并发分片数 | `4` |
| `ASR_MAX_RETRIES` | 单分片最大重试次数 | `3` |
| `MAX_UPLOAD_BYTES` | 单次上传上限 | 2 GiB |
| `MAX_CONCURRENT_UPLOADS` | 同时进行的上传数上限（超出返回 429 `upload_limit`）；`ASR_CONCURRENCY` 只约束上游调用，不约束落盘 | 2 |
| `MIN_FREE_DISK_BYTES` | 剩余磁盘低于该值（加上本次声明的上传大小）时拒绝上传，返回 507 `insufficient_storage`；`0` 关闭检查 | 512 MiB |
| `TASK_TTL_SECONDS` | 内存中任务状态的保留时长 | 3600 |
| `OUTPUT_TTL_SECONDS` | 已结束任务的产物（音频/结果/字幕）保留时长，历史记录页按此说明展示 | 7 天 |
| `HISTORY_REFRESH_SECONDS` | 历史列表缓存索引的最长陈旧时间；每轮刷新按归档条数各 stat 一次，刚结束的任务会强制刷新 | 1.0 |
| `REALTIME_ASR_PROVIDER` | 实时后端：`realtime_mock` / `realtime_http` / `realtime_ws` / `realtime_offline` | `realtime_mock` |
| `REALTIME_MAX_SESSIONS` | 同时进行的实时会话上限（按所有客户端合计计数，超了返回 429） | 4 |
| `REALTIME_MAX_CHUNK_BYTES` | 单个实时音频块上限 | 1 MiB |
| `REALTIME_MAX_SESSION_BYTES` | 单个实时录音的累计字节上限 | 100 MiB |
| `REALTIME_MAX_SESSION_SECONDS` | 单个实时录音的时长上限 | 3600 |
| `ACCESS_TOKENS` | 逗号分隔的访问令牌；远程开放服务前必须设置 | *(空，仅建议 loopback 部署)* |

模型列表探测只会访问当前运行配置或已保存配置档案中的 endpoint。新增自托管 ASR 地址时先保存配置档案，再执行模型探测；已保存的内网地址仍可使用。

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
│   │   ├── realtime_ws.py       Qwen3-ASR WebSocket + WebM→PCM 实时适配
│   │   ├── realtime_offline.py  离线 ASR 模拟 realtime provider
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
- **说话人分离落地下游**：`Word.speaker` 与实时链路已经打通，缺的是把 `openai_compat` 的 `verbose_json.segments[].speaker` 灌进 `words[]`，让文件任务字幕也带 `[说话人]`
- **翻译 / 摘要**：拿到完整文本后接 LLM
- **任务队列**：当前任务在进程内 `asyncio.create_task` 调度；横向扩展可替换为 Celery / RQ + Redis

更新日志：[CHANGELOG.md](CHANGELOG.md)。

## License

[MIT](LICENSE) © 2026 shigy
