# MediaFlow 现场部署与配置指南

> 适用版本：`mediaflow:1.8.6`（**arm64**）。面向离线内网环境，全程无需联网。

> **这份文档管什么**：MediaFlow 应用本身在现场的部署、配置、验证、运维、排错。
> 上游 ASR 服务怎么起不在这里：昇腾 NPU 上的 Qwen3-ASR（8022/8023）见 [deploy/qwen3-asr-npu/DEPLOY.md](deploy/qwen3-asr-npu/DEPLOY.md)；
> 镜像太大要切分带进离线现场（含分片校验、合并、NPU 卡号确认）见 [ONSITE_DEPLOY.md](ONSITE_DEPLOY.md)；
> 现场只需要流式服务、基础镜像已就位见 [STREAMING_ONSITE_DEPLOY.md](STREAMING_ONSITE_DEPLOY.md)；
> CUDA 宿主上跑 `asr-deploy-code/` 真实服务见 [deploy/qwen3-asr-cuda/README.md](deploy/qwen3-asr-cuda/README.md)。

---

## 一、交付清单

把以下文件放到现场主机**同一个目录**下：

| 文件 | 说明 |
|---|---|
| `mediaflow-1.8.6-arm64.tar.gz` | Docker 镜像离线包（arm64） |
| `docker-compose.prod.yml` | 部署编排文件（host 网络、只跑不构建） |
| `.env.example` | 配置模板，据此生成 `.env` |
| 本文档 | 部署 / 配置 / 验证 / 排错说明 |

---

## 二、前置要求

- 目标主机 **arm64（aarch64）** 架构，已安装 Docker（含 `docker compose` 插件）
- 一个空闲端口（默认 **8999**），宿主防火墙 / 安全组允许该端口
- 部署目录有写权限(容器会在此创建 `temp/`、`outputs/`、`config/`),并且能 `sudo` 改这三个目录的属主（见第三节第 3 步）。

> 确认架构：`uname -m` 应为 `aarch64`。若为 `x86_64`，本 arm64 镜像无法运行，需向构建方索取 amd64 包。
>
> 交付包的架构由**构建它的机器**决定：`build.sh` 按构建机的 `uname -m` 选架构，所以 arm64 包必须在 arm64 打包机上 `./build.sh --save` 产出。跨架构构建（`--platform linux/arm64`）只在打包机架构不符时兜底，每一层都在 QEMU 模拟下执行，apt/pip 层耗时是原生的数倍。

---

## 三、部署步骤

```bash
# 1. 加载镜像
docker load -i mediaflow-1.8.6-arm64.tar.gz

# 2. 生成配置文件（要改什么见第四节）
cp .env.example .env
vi .env                 # 至少把 ASR_BASE_URL 改成内网 ASR 地址

# 3. 数据卷属主(必须做一次,原因见下方说明)
mkdir -p temp outputs config
sudo chown -R 10001:10001 temp outputs config

# 4. 启动(只跑现成镜像,绝不在现场构建)
docker compose -f docker-compose.prod.yml up -d

# 5. 验证
curl -sf http://localhost:8999/health && echo "  ← 服务已启动"
```

> ⚠️ **第 3 步不能省**：镜像以非 root（uid `10001`）运行，而 `temp/`、`outputs/`、`config/` 是宿主机创建的目录，属主是部署用户。属主不对时容器**会直接拒绝启动**，日志最后一行就给出要执行的 `chown` 命令。（旧版本是能启动、`/health` 正常，但第一次上传、保存配置或打开配置页才失败，更难排查。）
>
> 现场不能执行 `chown`（没有 sudo、目录属主不能改、多个服务共用同一目录）时，改为让容器直接用目录的属主运行：在 `.env` 里加
> `MEDIAFLOW_UID=<属主 UID>` / `MEDIAFLOW_GID=<属主 GID>`（`id -u 部署用户` 取 UID），第 3 步的 `chown` 就不需要了。两个 compose 文件都认这两个变量，取值方式与 `docker-compose.yml` 一致。

启动后浏览器打开 `http://<本机IP>:8999/`（用 `hostname -I` 查看本机 IP）。

---

## 四、配置说明

配置有两种方式，**按场景选用**：

### 方式 A — 编辑 `.env`（推荐用于固定配置）
声明式，**容器重建（升级镜像、down/up）也不丢**。适合 ASR 连接地址、密钥这类"装一次就固定"的信息。
改完执行 `docker compose -f docker-compose.prod.yml up -d --force-recreate` 让新值生效。

### 方式 B — 网页设置面板（方便，用于临时调参）
浏览器进入页面后，在**设置面板**里改 ASR 地址、模型、切片策略、并发等，保存后**即时生效、无需重启**。
网页改的值存在宿主机的 `config/runtime_config.json` 里（compose 已把 `./config` 挂进容器），**升级镜像或重建容器都不会丢**。该文件含密钥，权限是 `0600`，不要提交到 Git 或拷给别人。

### 必须配置的项

| 配置项 | 必改 | 说明 |
|---|---|---|
| `ASR_BASE_URL` | ✅ | 内网 ASR 地址（如 `http://10.x.x.x:9000/v1`）。默认是公网 dashscope，**离线必然连不上** |
| `ASR_PROVIDER` | ✅ | 按内网 ASR 的接口风格二选一（见下表） |
| `ASR_MODEL` | ✅ | 内网 ASR 的模型名 |
| `ASR_API_KEY` | 视情况 | 内网 ASR 若需鉴权则填，否则留空 |

**`ASR_PROVIDER` 怎么选：**

| 取值 | 上游端点 | 适用 | Word 时间戳 |
|---|---|---|---|
| `openai_compat` | `POST /v1/audio/transcriptions`（multipart） | Whisper API、faster-whisper-server、DashScope compat transcriptions、FunASR/SenseVoice 的 OpenAI 网关 | ✅ 字幕更精准 |
| `openai_chat_audio` | `POST /v1/chat/completions`（JSON + base64 input_audio） | vLLM Qwen3-ASR-Flash、把音频模型当多模态 LLM 的部署 | ❌ 字幕按分片粒度 |

> 能用 `openai_compat` 就优先用它（有词级时间戳，字幕质量更好）。具体取决于内网 ASR 暴露的是哪种端点。

### 实时识别（边说边出字）的配置

文件转写与实时识别是**两条独立的上游链路**，各自一套地址、一个接口类型。文件转写测通了，不代表实时识别也通。

| 用途 | 配置项前缀 | 上游接口形状 |
|---|---|---|
| 文件转写 | `ASR_*` | OpenAI 兼容 HTTP（`/v1/audio/transcriptions` 或 `/v1/chat/completions`） |
| 实时识别 | `REALTIME_ASR_*` | 流式接口：WebSocket 或 HTTP+SSE，**与上一行不是同一个协议** |

`REALTIME_ASR_PROVIDER` 只有四个取值（写别的值启动即报错，错误信息会列出可用取值）：

| 取值 | 对接什么 | 地址写法 |
|---|---|---|
| `realtime_ws` | Qwen3-ASR 原生 WebSocket 服务，即仓库根目录 `asr-deploy-code/` 那一套，端点 `/v1/asr/stream` | `ws://<IP>:<端口>/v1/asr/stream` —— **必须带路径** |
| `realtime_http` | 通用 HTTP+SSE 会话协议：`POST {base}/session` → `/session/{id}/audio` → `/session/{id}/events`（SSE）→ `/session/{id}/end`。仓库内只有 `deploy/qwen3-asr-npu/streaming_server/` 实现了它 | `http://<IP>:<端口>` —— **不带路径** |
| `realtime_offline` | 不连上游流式服务：浏览器录完音后调用上面的 `ASR_PROVIDER` 整段识别，再以 SSE 逐字推回。用于「没有流式服务但要有边说边出字的观感」 | 不需要地址 |
| `realtime_mock` | 无模型依赖，按规则产出 online/final/done。用于自检前端、事件流、鉴权 | 不需要地址 |

最常见的配错是把两套接口串起来：`asr-deploy-code/` 那套真实服务**没有 `/session/...` 接口**，配 `realtime_http` 连不上；反过来 `streaming_server` 没有 WebSocket 端点，配 `realtime_ws` 同样连不上。两套服务的部署与配置写法见 [deploy/qwen3-asr-cuda/README.md](deploy/qwen3-asr-cuda/README.md)——它给出的是同一个服务的两套接口同时对接（`realtime_ws` 走 `/v1/asr/stream`、`openai_compat` 走 `/v1`）的完整示例。

`.env` 里配实时识别（与页面「服务配置 → 实时识别」等价，落 `.env` 更稳）：

```ini
REALTIME_ASR_PROVIDER=realtime_ws
REALTIME_ASR_BASE_URL=ws://10.x.x.x:8022/v1/asr/stream
REALTIME_ASR_API_KEY=
REALTIME_ASR_MODEL=qwen3-asr
REALTIME_MAX_SESSIONS=4              # 同时进行的会话数上限，超出返回 429
REALTIME_MAX_CHUNK_BYTES=1048576     # 单个音频包字节上限
REALTIME_MAX_SESSION_BYTES=104857600 # 单个会话累计字节上限
REALTIME_MAX_SESSION_SECONDS=3600    # 单个会话最长时长
```

> `REALTIME_MAX_SESSIONS` 默认 4，不是保守的拍脑袋数字：上游推理是串行的，实测 6 路尾延迟 >4s、8 路只有 1/8 的会话能在 20s 内拿到终稿。现场要几个人同时录音，按这个数字规划人数；调大它只会让所有人一起变慢。

浏览器侧：一个 `MediaRecorder` 连续产出 WebM/Opus 增量流并按 `seq` 串行上传，MediaFlow 为每个会话常驻一个 ffmpeg 进程把字节解成 16 kHz 单声道 PCM 再喂上游——所以**镜像内必须有 ffmpeg**（已内置，自建镜像时别省）。

### 其他常用项（有合理默认，按需调）

- `PORT`：监听端口，默认 `8999`
- `ACCESS_TOKENS`：访问令牌，逗号分隔；**留空 = 不鉴权**（内网可信环境通常留空）
- `MAX_UPLOAD_BYTES`：单文件上传上限，默认 `2147483648`（2 GiB）
- `FFMPEG_TIMEOUT` / `FFMPEG_CONCURRENCY`：单 ffmpeg 进程超时（默认 1800s）/ 并发切片进程数（默认 4，按 CPU 核数调）
- `SPLIT_STRATEGY`：切分策略 `silence`(默认) / `fixed` / `overlap`
- 其余项见 `.env.example` 内的注释

---

## 五、网络与防火墙

prod.yml 使用 **host 网络**——容器直接绑宿主端口，绕开 docker bridge（MAAS/OpenStack、firewalld 主机的 bridge 端口发布会**静默失效**，这是离线节点最常见的"服务起了却连不上"原因）。因此：

- 服务监听宿主的 `PORT`（默认 8999），**外网能否访问取决于宿主防火墙 / 安全组**。
- 放行端口：

```bash
# Ubuntu
sudo ufw allow 8999/tcp
# RHEL / Rocky
sudo firewall-cmd --add-port=8999/tcp --permanent && sudo firewall-cmd --reload
```
> 若主机是 **OpenStack 虚机**，还需在**安全组**放行入站 TCP 8999——这条最容易漏。

---

## 六、验证

```bash
# 1. 服务存活（无需 token）
curl -sf http://localhost:8999/health
#    期望：{"status":"ok"}

# 2. ASR 连通性自检 —— 发一段 1s 静音到上游 ASR，验证地址/密钥/协议是否正确
curl -sf -X POST http://localhost:8999/asr/ping | python3 -m json.tool
#    期望：{"ok": true, "base_url": "...", "model": "...", "elapsed_ms": ...}
#    若 ok=false 或超时 → ASR 地址/密钥/协议配错，或宿主到 ASR 网络不通

# 3. 端到端：浏览器开 http://<本机IP>:8999/ ，上传一小段音频，看是否出字幕
```

> 若设置了 `ACCESS_TOKENS`，上面 `/asr/ping` 需加 `-H "Authorization: Bearer <你的token>"`；`/health` 不需要。

---

## 七、日常运维

```bash
docker compose -f docker-compose.prod.yml logs -f      # 看日志
docker compose -f docker-compose.prod.yml ps           # 看状态
docker compose -f docker-compose.prod.yml restart      # 重启（不丢网页配置）
docker compose -f docker-compose.prod.yml down          # 停止
docker compose -f docker-compose.prod.yml up -d         # 启动
```

**数据位置**（均在 compose 文件所在目录下）：
- `outputs/` — 转写结果 JSON，**永久累积**，需定期清理老文件以免占满磁盘
- `temp/` — 处理中转文件，服务停止时可清空
- `.env` — 你的配置；`config/runtime_config.json` — 网页端改的配置（含密钥，重建不丢）

**升级镜像**（拿到新版本 tar 包时）：
```bash
docker load -i mediaflow-<新版本>-arm64.tar.gz
# 若版本号变了，改 docker-compose.prod.yml 里 image: 的 tag
docker compose -f docker-compose.prod.yml up -d        # 自动用新镜像重建容器
```
> `outputs/`、`temp/`、`config/` 都是数据卷，升级镜像重建容器不受影响，网页端配置不会丢。
>
> ⚠️ 从 1.7.x（以 root 运行）升到 1.8.0 时，`outputs/`、`config/` 里的旧文件属于 root，以 uid `10001` 运行的容器既改不了也删不掉。升级前同样执行一次第三节第 3 步的 `chown -R`。

---

## 八、故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 本机 `curl localhost:8999/health` 不通 | 容器没起来 | `... logs` 看报错、`... ps` 看状态 |
| 启动报 `image not found` | 镜像没加载或版本号不符 | `docker images` 确认有 `mediaflow:1.8.6`，与 compose 的 `image:` 一致 |
| 本机通、外部电脑打不开 | 防火墙 / 安全组没放行 | 见第五节放行 8999 |
| `/asr/ping` 返回 `ok=false` 或超时 | ASR 地址 / 密钥 / 协议错，或网络不通 | 核对 `ASR_BASE_URL`/`ASR_API_KEY`/`ASR_PROVIDER`；在宿主上 `curl` 内网 ASR 地址确认可达 |
| 字幕没有词级时间戳 | 用了 `openai_chat_audio` | 内网 ASR 支持 transcriptions 端点时改用 `openai_compat` |
| 实时识别一打开就失败、上游无事件 | `REALTIME_ASR_PROVIDER` 与上游协议不符：`asr-deploy-code/` 那套用 `realtime_ws`，`streaming_server` 那套用 `realtime_http` | 见第四节「实时识别的配置」；地址该不该带路径也是常见错因 |
| 实时识别第 5 个人报「会话已满」/429 | 超出 `REALTIME_MAX_SESSIONS`（默认 4） | 见第四节。上限来自上游推理串行，调大只会让所有人变慢 |
| 录音一会儿后自动结束 | 触发 `REALTIME_MAX_SESSION_SECONDS` / `REALTIME_MAX_SESSION_BYTES` | 见第四节，按需调大 |
| 上传大文件报 413 | 超过 `MAX_UPLOAD_BYTES` | 调大该值后重建生效 |
| 启动即退出，日志末行提示 `data volume（s） ... not writable by uid 10001` | `temp`/`outputs`/`config` 属主不是 uid 10001 | 执行 `sudo chown -R 10001：10001 temp outputs config` 后重新 `up -d`；不能 chown 时在 `.env` 设 `MEDIAFLOW_UID` / `MEDIAFLOW_GID` 为目录属主 |
| 重启后任务消失 | 进行中任务不持久化 | 见第九节，重启选业务空闲时段 |

---

## 九、重要约束

- **单 worker 运行**：任务状态、进度、实时会话都在单进程内存里。镜像默认单 worker，**切勿给 uvicorn 加 `--workers`**——多进程间状态不共享会导致任务与事件错乱。
- **进行中任务不持久化**：服务重启会丢失正在处理的任务（已完成结果保存在 `outputs/`）。重启请选业务空闲时段。
- **网页配置不持久于重建**：见第四节方式 B；ASR 连接信息请落 `.env`。
- **`outputs/` 无自动清理**：永久累积，需人工或 cron 定期清理。
