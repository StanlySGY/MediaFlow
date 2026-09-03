# Handoff — Qwen3-ASR 流式接入 / AutoDL 部署

> 用法：下次开新会话时说一句「读取 handoff.md 恢复上下文」即可继续。
> 最后更新：2026-09-03。AutoDL 已部署完并经隧道打通，见「当前实际拓扑」；服务端修了一个空转写 bug，见「服务端已修的 bug」。

## 背景一句话

现场用的是 Qwen3-ASR 原生 WebSocket 流式接口（`realtime_ws`），你自己要在 AutoDL 上另起一套用于本地验证的服务，用的是仓库自带的 `deploy/qwen3-asr-npu/streaming_server/server.py`——这套走的是 **HTTP + SSE**，对应 MediaFlow 里的 `realtime_http` provider，**不是** `realtime_ws`。

**部署到 AutoDL 后，MediaFlow 侧要配：实时接口类型 = `realtime_http`，实时接口地址 = `http://<AutoDL映射地址>`（不带路径后缀）。** 配成 `realtime_ws` 会连不上。

这意味着 AutoDL 自建环境测不到现场那条 `realtime_ws` 代码路径（`app/services/asr/realtime_ws.py`），但对当前要验证的东西——SSE 契约、前端渲染、全量 vs 分句——完全够用，因为 MediaFlow 推给调用方的 SSE 格式跟用哪个 provider 无关（两条 provider 路径最终都会喂给同一套下游 SSE 格式）。

---

## 重大转向：不再用仓库自带的简化版 streaming_server，改为原样复刻现场服务

之前几轮说的「AutoDL 部署 deploy/qwen3-asr-npu/streaming_server/server.py」这条路线已经放弃。原因：那只是一个我搭的简化验证用具（SSE 协议、累计全文、无 VAD），跟现场真实架构不是一回事，测不出 MediaFlow `realtime_ws` provider 里 `_dispatch_server_frame`/`_render_text` 那部分逻辑。

现在的新计划：你已经从同事那里拿到了现场真实部署的那套 WebSocket 流式服务的完整源码，放在仓库根目录的 `asr-deploy-code/` 目录下（已入库，见下方「服务端已修的 bug」）。目标是把这套服务原样部署到你能拿到的 GPU 环境上，然后 MediaFlow 配置成真正的 `REALTIME_ASR_PROVIDER=realtime_ws` 去联调，而不是 `realtime_http`。

### `asr-deploy-code/` 源码结构与关键发现

```
asr-deploy-code/
├── __init__.py          (from .version import VERSION)
├── version.py           (VERSION = "1.0.0")
├── config.py            (pydantic-settings，ASR_ 前缀环境变量)
├── engine.py            (推理引擎：transformers 或 qwen_asr 两种后端，自动探测)
├── session.py           (StreamSession：VAD 切句 + partial/delta/final 状态机)
├── vad.py               (StreamVad：纯 numpy 能量+过零率 VAD，零额外依赖)
├── audio.py             (PCM 解码、重采样、ffmpeg 容器转码)
├── schemas.py           (Pydantic 响应模型)
├── main.py              (FastAPI app 入口，硬编码 `uvicorn.run("app.main:app", ...)`)
└── routers/
    ├── health.py        (/healthz /readyz /v1/info)
    ├── http.py           (POST /v1/audio/transcriptions，OpenAI 兼容 + SSE)
    └── ws.py             (WebSocket /v1/asr/stream，跟你贴的 API 文档完全对应)
```

**好消息 1**：`config.py` 里 `device: Literal["npu", "cpu", "cuda"] = "npu"`，`engine.py` 的 `init_device()` 只有 `device=="npu"` 分支才碰 `torch_npu`/Ascend 专属 API，`cuda`/`cpu` 分支干净直接返回。**这份代码本来就是跨设备兼容的，切 N 卡不用改一行代码**，只需要把环境变量 `ASR_DEVICE` 设成 `cuda`。

**好消息 2**：`engine.py` 里 `_load_qwen_asr()` 走的是 `Qwen3ASRModel.from_pretrained(...)`（transformers 风格直接加载），不是 vLLM 的 `.LLM()` 方式，所以**不需要装 `qwen-asr[vllm]` 这个重量级 extra**，`pip install qwen-asr` 就够，避免了 vLLM 在 CUDA 上装不装得上的顾虑。

**需要注意的坑**：
1. 目录名 `asr-deploy-code` 带连字符，Python 包名不合法，且 `main.py` 硬编码了 `app.main:app`，说明这个包原本目录名就叫 `app`。**部署时必须把目录改名为 `app`**，从其上级目录用 `python -m app.main` 或 `uvicorn app.main:app` 启动。
2. 需要 `uvicorn[standard]`（带 `websockets` 依赖），裸 `uvicorn` 跑不了 WebSocket 路由。
3. 环境变量前缀是 `ASR_`（不是 `MODEL_DIR` 那种老命名），比如模型路径是 `ASR_MODEL_PATH`，设备是 `ASR_DEVICE`，端口是 `ASR_PORT`。

### 部署到 GPU 环境的命令（不区分 AutoDL 还是别的，只要有 CUDA + 能跑 python）

```bash
mkdir -p /root/qwen3-asr-service
cd /root/qwen3-asr-service
# 把本地 asr-deploy-code/ 整个目录内容传上来，重命名为 app/

pip install "uvicorn[standard]" fastapi pydantic pydantic-settings numpy soundfile python-multipart
pip install qwen-asr          # 不要装 [vllm] extra
apt-get update && apt-get install -y ffmpeg

export HF_ENDPOINT=https://hf-mirror.com
pip install huggingface_hub
huggingface-cli download Qwen/Qwen3-ASR-1.7B --local-dir /root/autodl-tmp/Qwen3-ASR-1.7B

cd /root/qwen3-asr-service
export ASR_MODEL_PATH=/root/autodl-tmp/Qwen3-ASR-1.7B
export ASR_DEVICE=cuda
export ASR_NPU_DEVICE_ID=0        # 字段名沿用 npu_device_id，对 cuda 一样生效，即卡号
export ASR_BACKEND=auto
export ASR_DTYPE=bfloat16
export ASR_PORT=8022
export ASR_WARMUP=true

python -m app.main
# 或：uvicorn app.main:app --host 0.0.0.0 --port 8022

curl http://127.0.0.1:8022/healthz
curl http://127.0.0.1:8022/readyz
curl http://127.0.0.1:8022/v1/info
```

MediaFlow 配置改为真正的 `realtime_ws`：
```
REALTIME_ASR_PROVIDER=realtime_ws
REALTIME_ASR_BASE_URL=ws://<部署地址>/v1/asr/stream
```

### 两个还没验证的风险点
1. `pip install qwen-asr` 在 CUDA 环境下能否正常装、`Qwen3ASRModel.from_pretrained(..., device_map="cuda:0")` 是否吃这些参数（`_load_qwen_asr()` 对 `TypeError` 做了逐步降级重试，容错不错，但没实测过）。
2. `Qwen/Qwen3-ASR-1.7B`（非 `-hf` 版）这个仓库名和权重结构是否与 `qwen_asr.Qwen3ASRModel.from_pretrained` 匹配。

---

## ⏸️ 悬而未决：等你确认一条命令的结果

**背景**：你说目标服务器「只有 docker 权限，没别的」（没有 root/裸机 shell，只能 `docker run`/`docker compose`）。这不代表不能部署，但取决于宿主机是否已经装好 **NVIDIA Container Toolkit**（让 Docker 容器能看到宿主机 GPU 的那层驱动桥接）。

**判断依据**：
- 如果宿主机装了 NVIDIA Container Toolkit：完全可以在 docker 里跑，`docker run --gpus all ...` 或 compose 里加 `deploy.resources.reservations.devices` 就行，用官方 `nvidia/cuda` 或 `pytorch/pytorch` 基础镜像，把 `asr-deploy-code/`（改名 `app/`）复制进镜像或挂载进去。跟前面「裸机部署」的命令基本一样，只是包一层 Dockerfile。
- 如果宿主机没装 NVIDIA Container Toolkit：容器内部 `torch.cuda.is_available()` 会返回 `False`，模型只能退化到 CPU 推理——Qwen3-ASR-1.7B 在 CPU 上跑流式识别会慢到没法用（正常应该是几百毫秒级的推理，CPU 上可能是几十秒），实际不可用。这种情况下建议放弃这台服务器，去租 AutoDL（AutoDL 的镜像默认已经配好 NVIDIA Container Toolkit，如果你在 AutoDL 上也用 docker 部署的话）。

**你需要做的确认**（任选一种）：
1. 如果你有该服务器的 SSH/控制台但只被限制了权限，尝试跑 `docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`——如果输出显卡信息（型号、显存），说明 Toolkit 装好了，可以在 docker 里正常用 GPU；如果报错找不到 `--gpus` 或 `nvidia-smi`，说明没配。
2. 如果你完全没有 shell，只能通过某个 Web 面板管理容器，问问该面板/供应商「容器是否支持挂载 GPU」，或者直接看有没有「GPU」相关的资源选项。
3. 如果以上都不确定，直接告诉我你是通过什么方式管理这个 docker 环境的（比如 Portainer 面板、云服务商的容器服务、还是自己 SSH 进去跑 docker 命令），我可以给出更具体的检测步骤。

**一旦你确认了检测结果，把输出发我，我就能给你：**
- 能跑：写好对应的 Dockerfile + docker run/compose 命令，直接照抄部署。
- 不能跑：确认转向 AutoDL，沿用上面「部署到 GPU 环境的命令」章节，只是加一层 Dockerfile 或者直接裸机跑（AutoDL 大多数场景给的是完整机器权限，不受 docker-only 限制）。

---

## ✅ 已完成：实时分句契约与 Unicode 偏移修复

结构化 realtime splice delta 已完成并继续维护在统一网关层。当前最终契约如下：

- realtime `text` 始终为空字符串；每条 `type=text` 事件的 `delta` 是结构化
  `{start, remove, text}` splice 操作。
- `start`/`remove` 是相对上一条已重建文本的 **UTF-16 code unit 偏移**，与浏览器
  JavaScript `String.slice()` 一致；`remove` 以 UTF-16 code unit 计数。
- 网关在 Python Unicode 码点边界上比较 provider 返回的全量文本，再把偏移转换为
  UTF-16 code unit，因此不会主动把一个 Unicode 字符拆成两半。
- 客户端按 `new = previous[:start] + text + previous[start + remove:]` 重建累计文本。
- file stream 的 `delta` 仍是普通字符串，并且恒等于该独立分片的 `text`；`done`/`error`
  的 `delta` 为 `null`。
- `realtime_http`、`realtime_ws`、offline/mock provider 继续输出 provider-level 全量文本，
  不需要各自实现差分；差分统一由 `app/api/routes.py` 计算。
- 只读取 realtime `text` 的旧外部客户端必须升级，因为 realtime `text` 已不再携带累计全文。

本次 Unicode 修复涉及 `app/api/routes.py`、`app/models/schemas.py`、`app/main.py`、
`frontend/src/types.ts`、`frontend/src/lib/splice.ts` 及对应测试；新增了 emoji 等非 BMP
字符的后端 UTF-16 偏移和前端重建回归覆盖。

---

## 悬而未决：无（截至本次更新）

上一轮的分句契约问题已经解决。目前没有阻塞性决策待你回复；下一步是 AutoDL 部署联调（见下方问题 2/3），如果部署或联调中出现新的分支决策，会更新在这里。

---

## 问题 1：为什么是全量文本，不是分句增量

根因在 `deploy/qwen3-asr-npu/streaming_server/server.py:221-224`：

```python
text = s.state.text or ""
if text and text != s.last_text:
    s.last_text = text
    _emit(s, "online", text=text, is_final=False)
```

`state.text` 是 qwen-asr 流式接口自己维护的**累计全文**（`model.streaming_transcribe` 每次调用后，`state.text` 就是从会话开始到现在识别出的全部文字），`streaming_server` 原样转发，没有做任何裁剪。

- **`realtime_http` 路径**（`app/services/asr/realtime_http.py`）：直接透传上游 SSE 里的 `text` 字段 → 全量。
- **`realtime_ws` 路径**（`app/services/asr/realtime_ws.py`，核心逻辑在 `_render_text`/`_dispatch_server_frame`，约第 455-608 行）：MediaFlow 自己按 `segment_id` 拼接多个 segment 的文字重建出全量字符串，再往外推 → 也是全量。

**结论**：两条路径都是全量，这是上游 Qwen3-ASR API 的形态（`state.text` 语义）决定的，不是某处代码疏忽。要改成分句/增量，必须在 MediaFlow 这层加一层"记住上次推送内容、算 diff"的逻辑，两个 provider 各自的 `_emit_text` / 对应转发点都要接入这层逻辑。

---

## 问题 2：AutoDL 选卡 —— 已定论，直接照做

- **模型**：Qwen3-ASR-1.7B，bf16 权重约 3.4GB。
- **真正吃显存的是 vLLM 的 `GPU_MEMORY_UTILIZATION=0.9`**（`server.py:49`）——它会预占整卡 90% 显存做 KV cache，跟模型本身多小无关。
- **推荐**：RTX 4090 24GB（单流延迟看主频，4090 更快；24GB 不用调参直接能跑）。
- **备选更便宜**：RTX 3090 24GB 也够，慢一些。
- **不建议 16GB 以下**：不是装不下模型，是 `max_inference_batch_size=32`（`server.py:79`）+ `max_new_tokens` 偏大，容易 KV cache 不够。真要省钱，把 `GPU_MEMORY_UTILIZATION` 调到 0.5 能在 16GB 卡上跑。
- **存储**：模型约 3.4GB，AutoDL 系统盘小，模型要下到**数据盘**（如 `/root/autodl-tmp/`）。

---

## 问题 3：AutoDL 部署步骤 —— 已定论，直接照做

现有 `deploy/qwen3-asr-npu/streaming_server/Dockerfile` 基于 `quay.io/ascend/vllm-ascend`（华为昇腾 NPU 镜像），**在 N 卡上跑不了**，AutoDL 上不要用这个 Dockerfile，直接在实例里裸跑更省事：

```bash
# 1. 选 PyTorch 2.x + CUDA 12.x 官方镜像开实例（4090 24GB）

# 2. 装依赖
pip install "qwen-asr[vllm]" fastapi uvicorn numpy
apt-get update && apt-get install -y ffmpeg

# 3. 下模型到数据盘（AutoDL 内网走 hf-mirror 更快）
export HF_ENDPOINT=https://hf-mirror.com
pip install huggingface_hub
huggingface-cli download Qwen/Qwen3-ASR-1.7B --local-dir /root/autodl-tmp/Qwen3-ASR-1.7B

# 4. 把 deploy/qwen3-asr-npu/streaming_server/server.py 传上去

# 5. 起服务
export MODEL_DIR=/root/autodl-tmp/Qwen3-ASR-1.7B
export GPU_MEMORY_UTILIZATION=0.9
export CHUNK_SIZE_SEC=2.0
uvicorn server:app --host 0.0.0.0 --port 8001

# 6. 自检
curl http://127.0.0.1:8001/health     # 期望 {"status":"ok","model_loaded":true}
```

然后 AutoDL 开**端口映射**（自定义服务），把公网地址填进 MediaFlow：
- 实时接口类型 = `realtime_http`
- 实时接口地址 = 映射出来的 `http://...`（不带路径）

`CHUNK_SIZE_SEC` 是延迟旋钮：调到 1.0 出字更快但推理更频繁；先用 2.0 跑通再调。

### 两个没法预先验证、卡住了发我报错即可的风险点
1. `qwen-asr[vllm]` 这个包在 CUDA 环境下能否正常装（现场是 Ascend NPU 分支，没在 CUDA 上验证过依赖树）。
2. HF 上 `Qwen/Qwen3-ASR-1.7B` 这个仓库名是否确切（没有实际访问过 HF 确认）。

---

## 涉及到的关键文件（下次直接读这些就能接上）

| 文件 | 作用 |
|---|---|
| `deploy/qwen3-asr-npu/streaming_server/server.py` | 你要部署到 AutoDL 的服务，HTTP+SSE，核心累计文本逻辑在第 221-224 行 |
| `deploy/qwen3-asr-npu/streaming_server/Dockerfile` | 现有 Docker 镜像，基于昇腾 NPU，**AutoDL 上不能用** |
| `app/services/asr/realtime_http.py` | MediaFlow 内 `realtime_http` provider，透传下游 SSE |
| `app/services/asr/realtime_ws.py` | MediaFlow 内 `realtime_ws` provider，自己拼 `_render_text`（约 455-608 行），对应现场环境 |
| `app/services/asr/realtime_registry.py` | provider 注册表，`realtime_http`/`realtime_ws` 两个 key |
| `deploy/qwen3-asr-cuda/` | **新增**：`asr-deploy-code/` 的 CUDA 容器封装（Dockerfile + compose + README），拉代码就能部署 |
| `STREAMING_ONSITE_DEPLOY.md` / `ONSITE_DEPLOY.md` / `DEPLOY_ONSITE.md` | 现场部署相关既有文档 |

## 服务端已修的 bug（`asr-deploy-code/engine.py`）

`_parse_qwen_asr_result` 原来是 `if not text: text = str(item)`，把「合法的空转写」和「字段缺失」混为一谈。静音或纯噪声片段会返回：

```
"text": "ASRTranscription(language='', text='', time_stamps=None)"
```

`qwen_asr` 后端下 partial（`session.py:198`）和 final（`session.py:262`）都会落到 `transcribe_sync` → 这个解析函数，所以呼吸、咳嗽、环境噪声这类被 VAD 放过但转写为空的片段，都会把这串 dataclass repr 当识别文本推进 SSE，MediaFlow 原样透传。已改为用 `_SENTINEL`（`engine.py:32` 本来就有）区分缺失与空值。

### 并发闸门形同虚设（本次修）

`transcribe()` 拿了 `_sem` / `_partial_sem`，但推理是 `run_in_executor(None, ...)` —— 事件循环默认的
无界线程池（`min(32, cpu+4)` 个线程）。信号量放行的请求全部同时进池抢 GIL 和显存，
`ASR_MAX_CONCURRENCY` 根本没限住任何东西，排队变成了颠簸。

`bind_loop()` 现在显式建一个 `ThreadPoolExecutor(max_workers=limit + partial_limit)`，
`transcribe()` 和 `transcribe_iter()` 里 `_build_inputs`/`_to_device` 那一处走这个池。
池大小必须是两个闸门之和：`_sem` 和 `_partial_sem` 是独立闸门，最坏情况同时有
`limit + partial_limit` 个阻塞调用；池开小了就成了第二道错位的闸门，把闸门已经放行的
请求又卡在池队列里。

`next(streamer_iter)` 和 `worker.join` **故意留在默认线程池**——纯等待、不吃 GIL，
挪进推理池只会白占推理槽位。`main.py` 的 lifespan 退出时先 `engine.shutdown()` 关池，
再 `engine.unload()`。

**改完要重启 GPU 机器上的服务才生效。**

## 容器封装（`deploy/qwen3-asr-cuda/`，本次新增）

拉代码到任意 N 卡机器，在**仓库根目录**执行：

```bash
docker compose -f deploy/qwen3-asr-cuda/docker-compose.yml up -d --build
curl http://127.0.0.1:8030/readyz     # 模型后台加载，首次约 1~2 分钟
```

只有两处要改，compose 里都标了 `←`：权重挂载路径、`ASR_API_KEY`。几个封装时踩到的点：

- `context` 必须是仓库根目录（compose 里已配 `context: ../..`），镜像要 `COPY asr-deploy-code/`。
- 目录名 `asr-deploy-code` 带连字符不是合法包名，而 `main.py` 用相对导入 + 硬编码
  `"app.main:app"`，所以镜像里必须重命名成 `/srv/app/`。
- `uvicorn` 得装 `[standard]`，否则没 websockets，`/v1/asr/stream` 直接 404。
  `qwen-asr` 不用加 `[vllm]`——引擎走 `Qwen3ASRModel.from_pretrained`。
- `torch_npu` 是干净可选的：`_probe_device()` 在 `engine.py:193` 就
  `if settings.device != "npu": return info` 提前返回了，CUDA 镜像不需要任何昇腾组件。
- `.dockerignore` 补了 `vllm-ascend-*.tar.gz` / `vllm-part-*` / `vllm-checksum.txt`。
  这三个离线交付包共约 13GB，没有任何 Dockerfile 从它们构建，但留在 build context 里
  每次 build 都会打包发给 daemon。排除后服务侧 payload 是 124K / 13 个文件。
- 权重不进镜像，靠挂载。换模型只改挂载路径和 `ASR_MODEL_PATH`，不用重建镜像。

昇腾那套仍在 `deploy/qwen3-asr-npu/`，两套并存。

## 当前实际拓扑（2026-09-01）

- ASR 服务：`172.16.100.26:8030`，AutoDL 实例经隧道打通。`backend=qwen_asr`、`device=cuda:0`。
- MediaFlow：`172.16.100.26:8999`。**注意这不是开发机** —— 改本地 `.env` 对它无效。
- MediaFlow 侧配置走的是**服务配置页**，不是环境变量。页面存 `runtime_config.json`，`get_settings()` 先读 `.env` 再把它盖上去（`app/config.py:146`），**页面永远赢**。回退用 `POST /asr/config/reset`。

配置页两段值（实时段和整段转写段打的是同一服务的两个不同接口，不能互串）：

| 段 | 字段 | 值 |
|---|---|---|
| 实时 | 接口类型 | `realtime_ws` |
| 实时 | 接口地址 | `ws://172.16.100.26:8030/v1/asr/stream` |
| 实时 | 密钥 / 模型名 | 都留空 |
| 整段 | 接口类型 | `openai_compat`（服务没有 `/chat/completions`，实测 404） |
| 整段 | 服务地址 | `http://172.16.100.26:8030/v1`（`/v1` 根，provider 自己拼 `/audio/transcriptions`） |
| 整段 | 密钥 | 清空（原有 DashScope 旧 key） |
| 整段 | 模型名 | `Qwen3-ASR-1.7B` |

逐字时间戳开关无所谓：`qwen_asr` 后端返回 `time_stamps=None`，词级时间轴拿不回来。

## 本次交付（三件都已完成）

1. **`language` 归一化**：`RealtimeSessionCreate.language` 文档写「zh / en」，但 `qwen_asr` 内部
   `capitalize()` 成 `Zh` 再拿全英文名白名单校验，直接 `ValueError: Unsupported language: Zh`。
   已在 `app/services/asr/realtime_ws.py` 加 `_normalize_language()`，`zh` → `Chinese`。
   直连服务端时要自己注意，上游只认全称。
2. **并发闸门**：见上方「并发闸门形同虚设」。是并发上限的问题，不是单会话卡死——
   单会话走 MediaFlow 自己的 UI 一直是正常的，之前那次「冻住」是我自己叠了三个并发测试会话。
   修法是有界线程池，不是 `ProcessPoolExecutor`。
3. **容器封装**：见上方「容器封装」。

本地验证：后端 `python -m pytest -q` → 141 passed（1 个既有 `StarletteDeprecationWarning`）；
前端 `npx tsc -b --noEmit` 干净、`npx vitest run` → 7 files / 18 tests passed；前端生产构建成功。
`docker compose config` → OK；两个改动文件 `py_compile` → OK。
**镜像没构建过、容器没跑过**——本地没有 GPU，这一步只能在目标机器上验。

注意：`npx eslint .` 仍有两个既有错误：`frontend/src/components/MonitorView.tsx:53` 的
`setState-in-effect` 规则，以及 `frontend/src/components/RealtimeView.test.tsx:71` 的未使用
`opts` 参数；本次 delta 修复未扩大处理范围。

## 下一步

1. ~~分句契约~~ 已完成，见上方「✅ 已完成」章节；已补齐 UTF-16 偏移的 emoji 回归测试。
2. ~~AutoDL 部署~~ 已完成，见上方「当前实际拓扑」。
3. 用户改完配置页后，跑端到端流式验证：SSE structured `delta` 契约、700ms 静音触发 `final` 的分句、前端渲染（含非前缀增长和非 BMP 字符替换语义）。
4. 服务端 bug 修复需重启 `172.16.100.26:8030` 上的服务后才生效。
5. 优先级低：`error` SSE 事件不带诊断 `text`，原因只能靠 `GET /asr/realtime/{sid}` 捞。

## 关于本文件维护的提醒（用户偏好，来自 memory）

- 完成代码改动后要主动 push 到 main，并给出 build 命令（不用等用户问）。
- 这个仓库里有多 GB 的离线交付 tar 包（`vllm-ascend-*.tar.gz`、`vllm-part-*`），**任何时候都不要 `git add -A`**，要精确 add 改动的文件。
