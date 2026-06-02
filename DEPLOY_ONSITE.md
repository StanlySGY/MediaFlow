# MediaFlow 现场部署与配置指南

> 适用版本：`mediaflow:1.4.0`（**arm64**）。面向离线内网环境，全程无需联网。

---

## 一、交付清单

把以下文件放到现场主机**同一个目录**下：

| 文件 | 说明 |
|---|---|
| `mediaflow-1.4.0-arm64.tar.gz` | Docker 镜像离线包（arm64） |
| `docker-compose.prod.yml` | 部署编排文件（host 网络、只跑不构建） |
| `.env.example` | 配置模板，据此生成 `.env` |
| 本文档 | 部署 / 配置 / 验证 / 排错说明 |

---

## 二、前置要求

- 目标主机 **arm64（aarch64）** 架构，已安装 Docker（含 `docker compose` 插件）
- 一个空闲端口（默认 **8999**），宿主防火墙 / 安全组允许该端口
- 部署目录有写权限（容器会在此创建 `temp/`、`outputs/`、`runtime_config.json`）

> 确认架构：`uname -m` 应为 `aarch64`。若为 `x86_64`，本 arm64 镜像无法运行，需向构建方索取 amd64 包。

---

## 三、部署步骤

```bash
# 1. 加载镜像
docker load -i mediaflow-1.4.0-arm64.tar.gz

# 2. 生成配置文件（要改什么见第四节）
cp .env.example .env
vi .env                 # 至少把 ASR_BASE_URL 改成内网 ASR 地址

# 3. 启动（只跑现成镜像，绝不在现场构建）
docker compose -f docker-compose.prod.yml up -d

# 4. 验证
curl -sf http://localhost:8999/health && echo "  ← 服务已启动"
```

启动后浏览器打开 `http://<本机IP>:8999/`（用 `hostname -I` 查看本机 IP）。

---

## 四、配置说明

配置有两种方式，**按场景选用**：

### 方式 A — 编辑 `.env`（推荐用于固定配置）
声明式，**容器重建（升级镜像、down/up）也不丢**。适合 ASR 连接地址、密钥这类"装一次就固定"的信息。
改完执行 `docker compose -f docker-compose.prod.yml up -d --force-recreate` 让新值生效。

### 方式 B — 网页设置面板（方便，用于临时调参）
浏览器进入页面后，在**设置面板**里改 ASR 地址、模型、切片策略、并发等，保存后**即时生效、无需重启**。
> ⚠️ **坑**：网页改的值存到容器内 `/app/runtime_config.json`，**不在数据卷里**——`docker restart` 不丢，但**升级镜像或 down/up 重建容器会丢失**。所以连接信息建议仍写进 `.env`。

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
| `openai_chat_audio` | `POST /v1/chat/completions`（JSON + base64） | vLLM Qwen3-ASR-Flash、把音频模型当多模态 LLM 的部署 | ❌ 字幕按分片粒度 |

> 能用 `openai_compat` 就优先用它（有词级时间戳，字幕质量更好）。具体取决于内网 ASR 暴露的是哪种端点。

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
- `.env` — 你的配置；`runtime_config.json` — 网页端改的配置（重建会丢，见第四节）

**升级镜像**（拿到新版本 tar 包时）：
```bash
docker load -i mediaflow-<新版本>-arm64.tar.gz
# 若版本号变了，改 docker-compose.prod.yml 里 image: 的 tag
docker compose -f docker-compose.prod.yml up -d        # 自动用新镜像重建容器
```
> ⚠️ 升级重建容器会**丢失网页端配置**（`runtime_config.json`）。ASR 连接信息务必写在 `.env` 里——它重建不丢。`outputs/`、`temp/` 是数据卷，升级不受影响。

---

## 八、故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 本机 `curl localhost:8999/health` 不通 | 容器没起来 | `... logs` 看报错、`... ps` 看状态 |
| 启动报 `image not found` | 镜像没加载或版本号不符 | `docker images` 确认有 `mediaflow:1.4.0`，与 compose 的 `image:` 一致 |
| 本机通、外部电脑打不开 | 防火墙 / 安全组没放行 | 见第五节放行 8999 |
| `/asr/ping` 返回 `ok=false` 或超时 | ASR 地址 / 密钥 / 协议错，或网络不通 | 核对 `ASR_BASE_URL`/`ASR_API_KEY`/`ASR_PROVIDER`；在宿主上 `curl` 内网 ASR 地址确认可达 |
| 字幕没有词级时间戳 | 用了 `openai_chat_audio` | 内网 ASR 支持 transcriptions 端点时改用 `openai_compat` |
| 上传大文件报 413 | 超过 `MAX_UPLOAD_BYTES` | 调大该值后重建生效 |
| 重启后任务消失 | 进行中任务不持久化 | 见第九节，重启选业务空闲时段 |

---

## 九、重要约束

- **单 worker 运行**：任务状态、进度、实时会话都在单进程内存里。镜像默认单 worker，**切勿给 uvicorn 加 `--workers`**——多进程间状态不共享会导致任务与事件错乱。
- **进行中任务不持久化**：服务重启会丢失正在处理的任务（已完成结果保存在 `outputs/`）。重启请选业务空闲时段。
- **网页配置不持久于重建**：见第四节方式 B；ASR 连接信息请落 `.env`。
- **`outputs/` 无自动清理**：永久累积，需人工或 cron 定期清理。
