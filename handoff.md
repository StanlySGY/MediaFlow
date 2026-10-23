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

## ✅ 已完成：六项改进（2026-09-03）

根据设计审查结果，已完成以下六项改进：

### 1. 缓存优化文档化
在 `_realtime_delta()` 函数文档中明确说明了缓存策略的局限性：该函数是无状态的差分计算，
调用方（SSE 订阅者循环）已经按连接隔离地跟踪 `previous_text`，因此差分函数无法自己缓存。
稳定前缀的提前退出对大多数追加写场景仍然有效，O(n) 复杂度在实时流场景下可接受。

### 2. 滑动窗口内存管理
新增 `_trim_old_segments()` 方法（`app/services/asr/realtime_ws.py:610-621`），在每次 final
事件记录后自动清理过期的旧 final 段。滑动窗口保留最近 128 个 final 段（约 5-10 分钟语音），
防止长会话中 `_final_segments` 字典无限增长导致的内存泄漏。

### 3. WebSocket 重连策略文档（本文档）
WebSocket 重连由客户端负责：连接断开时保留 `session_id`，用原 `session_id` 重新订阅
`/asr/realtime/{session_id}/events` 即可继续接收事件（该 SSE 端点会重放历史 + 推送新事件）。
服务端维护会话状态直到 TTL 过期（默认 300 秒）。不支持 WebSocket 层面的自动重连，因为
`realtime_ws` provider 是直连模式，MediaFlow 作为客户端不实现重连池。

### 4. 可配置 VAD 静音阈值
在 `RealtimeSessionCreate` schema 中新增 `vad_silence_ms` 字段（`app/models/schemas.py:212-218`），
允许调用方覆盖默认的 700ms 静音切句阈值，范围 100ms-5000ms。适用于需要更敏感或更宽容分句的场景。

### 5. 增强错误诊断字段
在 `ASRStreamEvent` schema 中新增 `error_code` 和 `hint` 字段（`app/models/schemas.py:162-173`），
为 `error` 类型事件提供结构化的错误代码和用户友好提示。`error_code` 便于客户端程序化处理
（如重试逻辑、特定错误页面跳转），`hint` 提供操作指引（如"请检查音频格式是否为 WAV/MP3"）。
**尚未在各 provider 的错误发射点统一实现**——当前各处仍只设置 `error` 字符串字段，需要逐一
review 错误路径并补充 `error_code`/`hint` 赋值。

### 6. `previous_text` 隔离警告强化
在 `_standard_realtime_sse_message()` 函数文档字符串开头添加 **CRITICAL** 标记
（`app/api/routes.py:494-499`），明确强调 `previous_text` 必须按订阅者连接隔离，不能作为
session_id 级别的共享状态。违反此隔离会导致并发订阅者在不同时间点加入时产生错误的 delta 计算。

---

## UI/UX 打磨记录（2026-10-21）

### 本轮真实浏览器观察
- 通过 Browser 工具打开 `http://127.0.0.1:8999/`，桌面页面可加载；文件转写首页显示上游 `openai_compat`、模型 `Qwen3-ASR-1.7B`、连接状态在线。
- 点击「实时识别」进入 `/#/realtime`，截图确认主工作区分为实时录音操作、实时文稿和可展开的调试日志；空状态下复制文稿/下载 TXT/复制日志按钮禁用，符合当前无内容时的预期。
- 实测浏览器没有麦克风权限，启动实时录音后按预期显示「麦克风权限被拒绝」及浏览器权限设置建议；实时会话 POST/DELETE 均 HTTP 200。修复前 UI 曾保留过期的「在用 1/4 路」，修复后重新部署再次实际点击，失败清理后显示「在用 0/4 路」。
- 在新部署版本中真实点击了「调试日志」→「复制」，页面确认显示「调试日志已复制到剪贴板」；这是浏览器真实交互验证，不只是测试断言。
- 历史记录页可加载任务列表、搜索/状态/日期筛选和分页控件；打开既有 `acceptance-silence.wav` 记录可展示完整文本及 TXT/SRT/VTT/JSON 导出控件。没有删除历史数据。
- 调用监控页可加载统计卡和明细；本地 `/asr/monitor` 返回 HTTP 200，且实时会话测试已出现在上游调用记录中。切页导致 SSE 请求 aborted 属于页面关闭连接的表现，不直接判为服务错误。
- 配置页的「测试连接」按钮被实际点击，`POST /asr/ping` 返回 HTTP 200。配置页的桌面固定操作栏占据视口底部；额外用 Headless Chrome 生成了 390×844 的配置页截图并查看了底部区域，确认操作栏在窄屏仍可见。增加了移动端底部留白以便继续滚动到最后的表单内容；仍需在更长页面滚动到末尾实际确认最后控件可完整移出操作栏上方。
- 文件转写 API 端到端：生成 2 秒 440Hz 测试音频后上传 `/asr/file` 返回 200，任务到达 `done`，状态和结果均 200；SRT/VTT 导出均 200。返回文本「嗯。」来自纯音测试文件，只证明任务/导出链路，不代表语音准确率。
- 输入校验与合并 API：`.exe` 上传返回 400；不存在任务返回 404；同一 WAV 合并两份后输出 WAV、时长为 4 秒、HTTP 200；混合 `.wav`/`.mp3` 文件合并返回 400。浏览器历史页的搜索 `mediaflow-ux-tone.wav`、状态筛选「已完成」和重置均可正常使用；未删除现有历史记录。
- 模型发现：在配置页点击文件 ASR 的「获取模型」后 `POST /asr/models` 返回 200；文件与实时端点的模型探测请求均返回 `Qwen3-ASR-1.7B`。
- 实时 API 端到端：创建会话、发送真实 PCM 数据包、发送空 final 标记，SSE 收到 final 与 done，状态转为 `done`，DELETE 后 `/asr/realtime/sessions` 为空；额外验证非法 base64 返回 400、空非 final 包返回 400。此处的合成音频只验证协议和资源生命周期，不代表人声转写准确率。
- 发现并复现了一个真实路由切换 UI 缺陷：从历史记录返回文件转写时 URL/标题已切换，但主内容区可能保持空白（重载后可恢复）。`frontend/src/App.tsx` 去掉外围 `AnimatePresence mode="wait"` 的退出等待，改为立即挂载目标页；`frontend/src/App.test.tsx` 新增从历史记录切换回文件转写的回归测试。修复部署后，在真实浏览器中点「历史记录」可显示 1350 条历史任务，再点「文件转写」在一次交互后可见原转写工作区和已有任务，URL 同步变为 `/#/tasks`。
- 本轮真实浏览器复查「音视频合并」页：标题、文件选择区域、「开始合并」按钮均可显示；「调用监控」页可显示统计卡片与调用明细空状态，不会报页面错误。其他页面的主要交互证据见上方各条，仍不代表所有控件都已逐一验收。
- 最新浏览器控制台诊断：MediaFlow 页面没有新增 JS console error/warning，跟踪到的 HTTP 4xx/5xx 为 0。历史页面间切换产生的中断型 SSE 请求单独看待，不混算成后端失败。
- 当前本地页面的配置/健康/任务/历史/监控请求基本均返回 HTTP 200。观测到的 `403 favicon.svg` 属于本轮曾短暂打开的另一个站点 `10.8.132.198:8088`，不是 MediaFlow 本地页面的请求错误。

### 本轮修复
- `frontend/src/components/RealtimeRecorderPanel.tsx`：调试日志复制新增成功提示和失败提示；剪贴板 API 不可用或权限拒绝时不再静默失败，并向辅助技术暴露 `status`/`alert`。
- `frontend/src/components/RealtimeRecorderPanel.tsx`：修复 `maxSessions` 配置异步到达导致 effect 清理后 `mountedRef` 一直为 false 的生命周期问题；释放实时会话后重新读取活跃会话数，避免麦克风被拒绝或会话失败时并发名额显示过期。
- `frontend/src/components/RealtimeView.test.tsx`：覆盖调试日志复制成功/拒绝，以及先未提供 `maxSessions`、再从配置传入、麦克风权限拒绝并释放名额的回归路径。
- `frontend/src/hooks/useFileTask.ts`、`frontend/src/App.tsx`：文件转写「复制全文」等待剪贴板写入成功后再显示已复制；失败显示可访问的页面内提示。JSON 导出错误从阻塞式 `window.alert` 改为页面内错误提示，保留用户当前转写文本。
- `frontend/src/hooks/useFileTask.test.ts`：新增文件转写复制成功与权限失败测试。
- `frontend/src/components/ConfigView.tsx`：窄屏时增加底部 padding（`pb-40 sm:pb-24`），减少固定操作栏挡住最后一组配置字段的风险。
- `app/services/asr/realtime_base.py`、`tests/test_realtime_routes.py`：实测发现空音频包但 `is_final=false` 的 400 响应被错误归类为 `internal_error`；现已分类为 `invalid_request`，并添加错误码/不可重试断言，避免调用方误认为服务端故障。
- `Dockerfile`：将 Python 基础镜像从浮动的 `python:3.12-slim` 明确为 `python:3.12-slim-trixie`。旧运行镜像已核实为 Debian Trixie；不应为固定 tag 降级为 Bookworm。Bookworm 构建因为下载 FFmpeg 的 Debian 系统依赖超过 360 秒时限而未完成，本地旧容器没有被替换，后续应以 Trixie 标签重建并通过健康检查验收。
- 验证：最新全量前端 18 个测试文件、111/111 测试通过；后端 276/276 测试通过；Ruff、ESLint、`tsc -b`、Vite production build 通过。`git diff --check` 通过。新后端在容器内实际验证空非 final 音频包错误分类为 `invalid_request`；本地服务重建后 `docker compose ps` 为 `healthy`，`GET /health` HTTP 200，配置继续指向 `openai_compat / Qwen3-ASR-1.7B` 和 `realtime_ws` 内网 WebSocket endpoint，会话列表为空。
- 为避免构建过程被系统包下载拖住，本轮先保留运行中的原镜像为 `mediaflow:baseline-ux-20261021`，再基于该镜像中的已安装 Python/FFmpeg 依赖，用 `/tmp/Dockerfile.mediaflow-ux-local` 构建前端新 bundle 和更新后的应用代码，成功后替换并健康检查。仓库 `Dockerfile` 已固定为 `python:3.12-slim-trixie`；但这次**干净基础镜像完整重建仍未完成验收**（apt 下载 FFmpeg 依赖长时间无进展/超时），需要在网络下载正常时再跑标准 `docker compose up -d --build` 验证可重复构建。
- 工作区原有 `.env` 未由本轮修改；临时测试 WAV 已删除；本轮没有提交或推送。

### 下一轮待完成
1. 在浏览器可允许麦克风的上下文（或用户提供短语音测试文件）验收真实录音、声音电平、partial/final、停止后最终结果和重连；本轮确认了权限拒绝恢复，但没有真实语音识别验收。
2. 补做 390px 的页面末尾滚动与横向溢出检查，尤其要确认配置固定操作栏不会遮住最后一个可交互控件；当前增加了 padding，但还没有完成全页末尾滚动验证。
3. 真实点击文件转写的 JSON/全文剪贴板失败提示，并用权限拒绝模拟覆盖；本轮已通过对应 hook/全量测试，但尚未在浏览器里人为拒绝剪贴板权限。
4. 音视频合并目前验证了 API 成功与混合格式拒绝，浏览器确认页面/文件选择入口显示，但尚未用真实浏览器文件选择器完成上传、合并、下载的完整 UI 链路；配置保存失败、监控异常断线恢复也仍需额外交互验证。不要清除已有历史记录，避免破坏测试数据。

## UI/UX 打磨记录（2026-10-23，第二轮）

### 本轮真实浏览器观察（本机后端 8081 + `vite.audit.config.ts` 前端 5174，Playwright + xvfb 真浏览器）
- 接口调试页文件模拟链路对真实上游 `realtime_ws`（`ws://172.16.100.28:8022/v1/asr/stream`）跑通：默认 `2pass` 与识别模式 `online` 各跑一次，「开始发送」后事件流持续出现 `[seq=… …ms]` 的「识别中」行；「停止」+「发送结束信号」后共 30 行事件，其中 2 个「最终」（seq=13 @15698ms、seq=29 @25284ms）与 1 个「结束」（seq=30），「复制会话文稿」由禁用变可用。上一轮报告里「事件流空白」是驱动脚本选错按钮/选择器造成的，不是产品缺陷。
- 录音页用假麦克风（`--use-file-for-fake-audio-capture=<wav>?loop=true`）跑通：页头显示「WebSocket 直连 · 边说边出字」、无演示 provider 引导、「在用 1/4 路」，67 条 `push_audio` + 12 条 `sse` 日志，静音阶段记到 `input_silent` 警告；全程只有 1 个 `final`（delta `{start:0, remove:17, text:""}` @32765ms）随后 `done`。
- 因此这次 SRT/VTT 各只导出一条 cue（`I'm like a child.`），页面上如实写着「字幕时间按本次录音的墙钟计时（上游未给出整句切点，导出为一整条）」。多切点的字幕输出目前只有测试证据（`RealtimeView.test.tsx` 的 SRT/VTT 用例 + `realtimeCueTracker` 9 个用例），真实多句切点要等上游开 VAD 或用带整句切点的 provider 才能现场验收。
- 原因在 `app/services/asr/realtime_ws.py:_build_start_frame`：`enable_vad` 写死 `False`（Qwen3-ASR 的 WebSocket VAD 会把短停顿过早判定为整句结束，导致丢词/改写），所以浏览器录音过程中拿不到句边界。
- 顺带发现 `RealtimeSessionCreate.vad_silence_ms`（`app/models/schemas.py:259`）是**没有任何 provider 或路由读取的死字段**：配置上可调、文档里写了默认 700ms，实际不影响任何行为。要么接进 provider，要么从 schema 去掉。

### 本轮修复
- `frontend/src/components/ConfigView.tsx`：`/asr/config` 后到时**整体替换**表单，把 `/asr/profiles` 已经填好的服务地址、模型名、接口类型全部清成空串；此时点「保存这份配置」会把空值 `PUT /asr/profiles/{id}` 写回档案 —— 一次页面加载即一次静默的数据丢失。改为 `setFormState(prev => ({...prev, ...initialForm}))`，只覆盖该接口真正负责的全局字段。
- `frontend/src/components/ConfigView.test.tsx`：新增回归测试，按真实到达顺序（`/asr/profiles` 里用 `setTimeout` 延后放行 `/asr/config`）复现，断言六个档案字段仍在、且随后的 PUT 请求体仍带全部六个字段。回退修复后该测试以「输入框为空」的症状失败。
- `frontend/src/lib/realtimeCueTracker.ts`（新）+ `lib/subtitle.ts`：按 `source_event === 'final'` 的帧在前端记整句切点，导出 SRT/VTT；`subtitle.ts` 抽出 `SubtitleCue` + `buildSrtFromCues` / `buildVttFromCues`，文件转写与实时共用同一套「空条目丢弃 + 0.1s 下限」规则。9 个单测覆盖：无切点、上游重复改写、splice 删字符、`elapsed_ms` 乱序、纯空白条目、`reset()`。
- `frontend/src/lib/labels.ts`（新）：provider / 切分策略 / 实时 provider 的中文表从 `ConfigView` 抽出，`Sidebar` 底部与 `RealtimeRecorderPanel` 头部改用同一张表；演示 provider 与 `realtime_offline` 的说明改为常驻并带「去服务配置」入口（此前只在首次引导里出现，改过一次配置就永久消失）。
- `frontend/src/components/ConcatView.tsx`：改回 XHR 取真实上传进度，字节送完后改口说「服务端正在拼接（不重新编码）…」，新增「取消」按钮、卸载时 abort、失败时把 blob 里的服务端错误体读回来显示。
- `frontend/src/components/SegmentList.tsx`：新增分片文本/分片号搜索、「只看失败（N）」筛选、命中计数与空结果出路；新分片只在用户本来就在列表末尾时才把视图拉下（IntersectionObserver），筛选变窄不滚动。
- `frontend/src/hooks/useFileTask.ts` + `App.tsx`：新增 `textConflict` / `syncFullTextFromSegments`，两个校对区分叉时页面说明哪份导出跟哪边，并提供「以分片为准统一」；复制全文/复制日志改为写入成功后才确认，JSON 导出失败从 `window.alert` 改为页内错误块。
- `frontend/src/components/RealtimeRecorderPanel.tsx`：`NotSupportedError`（Chrome 在无音频输入设备/远程桌面/虚机里抛的 "Not supported"）改为说明缺什么、去哪儿确认的中文提示；`maxSessions` 异步到达后恢复 `mountedRef`，并在 DELETE 完成后刷新「在用 N/M 路」。
- `frontend/src/main.tsx`：`MotionConfig reducedMotion="user"`，此前 `index.css` 的动画抑制覆盖不到 framer-motion 的路由/视图过渡。
- `frontend/src/App.tsx`：去掉外围 `AnimatePresence mode="wait"` 的退出等待（实测从「历史记录」回「文件转写」主区会留白，需刷新恢复），并按视图写 `document.title`（含前进/后退路径）。
- `frontend/src/index.css`：删掉无组件引用的 `.step` / `.step .num`；声音波形与 `prefers-reduced-motion` 块纳入 `@layer`。
- `app/services/asr/realtime_base.py` + `tests/test_realtime_routes.py`：空包但 `is_final=false` 的 400 此前归类 `internal_error`，现归 `invalid_request` / `retryable: false`。
- `Dockerfile`：`python:3.12-slim` → `python:3.12-slim-trixie`；`.env` 设 `MEDIAFLOW_UID/GID=1000`（宿主用户），配合 `docker-compose.yml` 的 `user:` 变量，避免为了可写去 `chown` 数据目录。
- 版本号 1.8.1：`app/main.py`、`frontend/package.json`、`build.sh`、`docker-compose.prod.yml` 四处一致，README / README.en / DEPLOY_ONSITE / ONSITE_DEPLOY 的 `mediaflow:1.8.1` 与 `mediaflow-1.8.1-arm64.tar.gz` 同步。

### 验证
- 前端：`npm run lint` 干净、`npx tsc -b` exit 0、`npm run test` → **20 files / 131 tests passed**、`npm run build` 成功（JS 472.34 kB / gzip 148.03 kB，CSS 48.83 kB）。
- 后端：`python3 -m pytest -q` → **276 passed**；`git diff --check` 干净。
- 浏览器：见上两节，接口调试与录音两条链路都在真 Chromium 里跑过并截图；假麦克风不是真实人声，只证明协议/生命周期/导出格式，不代表识别准确率。

### 下一轮待完成
1. **多切点字幕的真实验收**：目前只有单条 cue 的真实证据。要么在 `realtime_ws` 侧给 `_build_start_frame` 加可配的 `enable_vad`（并验收它不会重演「短停顿过早收尾、丢词」），要么用 `realtime_http` 验一次多句边界；顺带处理 `vad_silence_ms` 这个死字段。
2. **干净基础镜像重建验收**：`python:3.12-slim-trixie` 的完整 `docker compose up -d --build` 仍未跑通（上一轮 apt 下载 FFmpeg 依赖超时），需要在网络正常时验证可重复构建并过健康检查。
3. 390px 窄屏页面末尾滚动与横向溢出检查（配置页固定操作栏是否遮住最后一个可交互控件），上一轮加了 padding 但未完成全页末尾验证。
4. 用真实浏览器文件选择器完成合并页的上传→合并→下载完整 UI 链路（本轮只验证了 XHR 进度/取消/错误体的代码路径与测试）。

## CI 修复记录（2026-10-23，同日第三轮）

推送 `7ecc334` / `v1.8.1` 后 GitHub Actions CI 失败（run 39909185467）。真失败只有一处，另外两格是被连带的：

- `test (3.11)` → `FAILED tests/test_history_and_uploads.py::test_refresh_is_throttled_unless_forced - assert 0 == 1`。
- `test (3.12)` 的 pytest 实际是 `276 passed` + Ruff `All checks passed!`，但矩阵默认 `fail-fast: true`，3.11 失败把它取消，页面上显示 `-`；`docker` job 因 `needs` 未运行。

### 根因（是产品 bug，不是测试写错）
`app/services/history_index.py` 用 `self._last_refresh = 0.0` 当「从未刷新」的哨兵，节流判断是 `now - self._last_refresh < refresh_seconds`，而 `now = time.monotonic()`。Linux 上 `monotonic()` 从开机起算：GitHub runner 是新机器，开机头几十秒里 `monotonic() < 60`，于是**第一次 `refresh()` 被当成「窗口内」直接 return**，`records()` 为空。同理 `invalidate()` 置 0.0 也失效 —— 刚开机时写完任务再刷新，新任务不进历史列表。

本地复现不了的原因：开发机 `monotonic()` 恒为几万秒，永远大于任何 `refresh_seconds`。用把时钟拨到 5.0s 的脚本确认两种情况（首刷被吞、invalidate 后仍看不到新任务）。

修法：哨兵改 `None`，`refresh()` 只在 `self._last_refresh is not None` 时才节流；`invalidate()` 置 `None`。测试 `test_refresh_is_throttled_unless_forced` 用 `monkeypatch` 把 `history_index.time.monotonic` 拨到 5.0s，覆盖「低开机时钟 + 首刷 / 窗口内 / invalidate 后立即可见 / force」四个阶段；把修复还原后它以 CI 里同样的 `assert 0 == 1` 失败，恢复后 `11 passed`。

同时检查了仓库里其它 `monotonic()` 用法（`stream_manager.completed_at`/`_evict_if_needed`、`routes.py` 的上游健康缓存）：它们的起点都来自一次真实读数，不是 0.0 哨兵，没有同类问题。

### CI 配置改动
- `test` job 加 `fail-fast: false`：两个 Python 版本各自报告结果，不再互相顶替。
- `setup-node` 的 `node-version: 20` → `22`（GitHub 已把 Node 20 强制跑在 Node 24 上，每次构建都发弃用警告；22 与本地 `node -v` 一致）。
- **action 大版本升级**（补充）：上一条只改了 `node-version`，警告仍在 —— 它报的是 action 自身 `action.yml` 里的 `using: node20`。逐个核实后升 `checkout@v4→v7`、`setup-python@v5→v7`、`setup-node@v4→v7`、`configure-pages@v5→v6`、`upload-pages-artifact@v3→v5`、`deploy-pages@v4→v5`（v5 内部嵌套的 `upload-artifact` 也从 v4/node20 换到 v7/node24）。`checkout@v7` 唯一行为变化是 `pull_request_target`/`workflow_run` 下拒绝检出 fork PR，本仓库没用到这两种触发。

### action 升级后的 CI 结果（run 39912101457 / 39912101487，commit `8c43d2b`）
`✓ test (3.11)` `✓ test (3.12)` `✓ frontend` `✓ docker` `✓ Pages build` `✓ Pages deploy`，且日志里 `##[warning]` 行数从升级前的 **4 条 → 0 条**（旧 run 39911184762 的 4 条正是 `checkout@v4` / `setup-python@v5` / `setup-node@v4` / `configure-pages@v5`+`upload-artifact@v4` / `deploy-pages@v4` 的 node20 警告）。注：`gh run view --json jobs` 的 `conclusionDetails` 和 `check-runs/{id}/annotations` 对这两个 run 都返回空，连旧 run 的已知警告也取不到，所以判定用的是日志里的 `##[warning]` 行。

### 修复后的 CI 结果（run 39911184762，全绿 1m38s）
`✓ test (3.11) 48s` · `✓ test (3.12) 51s` · `✓ frontend 41s` · `✓ docker 42s`；Pages run 39911184644 也绿。`docker` job 日志确认基础镜像按 digest 解析：`FROM python:3.12-slim-trixie@sha256:a0f57064…`，`naming to docker.io/library/mediaflow:ci done` —— 这同时给上面「下一轮待完成」第 2 条的一个侧证：**CI 里的 `docker build` 能干净跑通**（含 apt 装 FFmpeg 的那几层），只是本机的 `docker compose up -d --build` 端到端验收仍未做。

### 版本
发布 **1.8.2**（四处落点 + 文档 tarball 名同步）。`v1.8.1` 已推送且不改写已发布 ref，所以单独发补丁版；**`v1.8.1` tag 的代码带这个历史列表 bug，不要用它构建交付**。

## 本地实例重启 + 1.8.2 验证（2026-10-23，同日第四轮）

### 实例状态变化
- 旧容器（`mediaflow:latest` = 1.8.0 镜像，`420484591b74`）已 `docker compose -f docker-compose.yml down --remove-orphans` 移除。**没有重建镜像**：本机当前无外网（见下），`./build.sh` 在 `RUN npm ci --include=dev` 处失败。
- 8999 上现在跑的是宿主进程直接执行仓库代码：`nohup env PYTHONPATH=. PORT=8999 HOST=127.0.0.1 python3 -m app.main`，日志 `~/.cache/mediaflow-local/run8999.log`。数据目录仍是仓库的 `./temp` `./outputs` `./config`（1465 个归档 + 24 个 state，`config/runtime_config.json` 0600，`active_provider: realtime_ws`），与容器版一致。
- 与容器的差别：没有 uid 10001/`MEDIAFLOW_UID` 那套用户设置，且 `HOST=127.0.0.1` 只监听回环（容器里 `HOST: 0.0.0.0`）。要恢复容器路径：网络恢复后 `./build.sh`（产出 `mediaflow:1.8.3` + `:latest`）再 `docker compose -f docker-compose.yml up -d`，或 `./build.sh --up`。

### 1.8.2 历史列表修复的实地证据
- `GET /openapi.json` → `"version":"1.8.2"`（当时）；`/health` 200；启动日志除既有的 `ASR_API_KEY is not set` 警告外无异常。
- **重启后第一次请求** `GET /asr/tasks?limit=5` → `rows: 5`、`total: 1464`。这条正是被修掉的哨兵 bug 会清空的调用路径。
- 限制说明：本机 `/proc/uptime` ≈ 24700s，`monotonic()` 恒远大于 `HISTORY_REFRESH_SECONDS`，所以这个 bug 在本地**本来就不会触发**；上面的证据只证明修复没把正常路径改坏，真正的复现证据仍是 CI 里那条 `assert 0 == 1` 和 `monkeypatch` 到 5.0s 的测试。

### 顺带发现并修掉的缺口 → 1.8.3
真浏览器逐个视图看标签标题时发现的：1.8.1 的按视图 `document.title` 只在 `handleViewChange` 和 `hashchange` 里调用，**冷启动直接打开 `#/history` 时两者都不运行**，标签仍是 `MediaFlow · 音视频处理`。先写 `App.title.test.tsx` 复现（修复前 `document.title` 为空串），再改为 `currentView` 上一个 `useEffect` 统一设置，删掉原两处调用。
- 前端：`npx tsc -b` exit 0、`npm test` → **21 files / 135 tests**、`npm run lint` 干净、`npm run build` 成功（JS 472.37 kB / gzip 148.05 kB，CSS 48.83 kB，新入口 `index-jSiCNCs6.js`）。
- 后端：`python3 -m pytest -q` → **276 passed**。
- 真 Chromium（CDP，`--remote-debugging-port=9333` + `~/.cache/mediaflow-local/scripts/cdp_title.py`）逐个导航实测：`/`→文件转写、`#/history`→历史记录、`#/concat`→音视频合并、`#/realtime`→实时识别、`#/config`→服务配置、`#/api-debug`→接口调试、`#/monitor`→调用监控，全部正确；`history.back()` / `forward()` 后标题也跟着变（`服务配置` → `接口调试`）。这是 1.8.1 那次改动只在 jsdom 里测过、没做真浏览器验收才漏掉的场景。
- 顺带记录两个测试环境陷阱：① `MonitorView` 直接读 `data.summary.window_size`，测试里 `/asr/monitor` 返回裸 `{}` 会让它崩（不是产品 bug，真实接口带 `summary`）；② `google-chrome --dump-dom --virtual-time-budget` 打开 `#/monitor` 会因为 SSE 挂住而超时返回空文件，用不带 virtual-time 的 `--dump-dom` 或 CDP 导航才拿得到页面。

### 仍然阻塞：镜像重建 / 交付 tar 包
上一轮写的「本机无外网」**不成立**，本轮推翻：宿主代理 `http://127.0.0.1:7897` 现在能通（`curl -x … https://registry.npmjs.org/-/ping` → 200），代理变量置空时 DNS 也能解析。Docker daemon 的代理来自 `/etc/systemd/system/docker.service.d/http-proxy.conf`（`HTTP(S)_PROXY=http://127.0.0.1:7897`，`NO_PROXY=localhost,127.0.0.1`）。

真正的阻塞是**构建层里的网络不稳**，两个不同表现：

1. **`npm ci` 静默漏装可选依赖**（已修）。失败信息是 `RUN npm run build` 报 rolldown `Cannot find native binding … Cannot find module '@rolldown/binding-linux-x64-gnu'`，但那不是构建阶段的问题：`node_modules/@rolldown/` 里只有 `pluginutils`，没有任何 `binding-*`，而 `node_modules/.package-lock.json` 却列了 7 个 `binding-linux` 条目。rolldown 的原生绑定是**可选依赖**，npm 拉那个 ~8.8 MB tarball 失败时不把 install 判为失败，只是把它略过——于是这一层被当成「成功层」缓存下来，缺绑定要等好几层之后才在 `npm run build` 里爆出来（npm/cli#4828）。实测同一条 `fetch()` 在构建层里 3 次里只成功 1 次（`FETCH OK 8822604` / `fetch failed` / `terminated`）。
   修法（`Dockerfile` stage 1）：`FROM node:20-slim` → `node:22-slim`（与 CI `setup-node: 22` 和开发宿主一致，npm 10.9.9 路径实测装出 `binding-linux-x64-gnu` + `musl` 且 `✓ built in 1.04s`）；`npm ci --include=dev` 后加 `node -e "import('rolldown')"` 完整性检查并整层重试，让缺绑定在**安装层**失败重跑，而不是缓存成一个坏层。本轮之后 `npm run build` 层已 CACHED 通过。
2. **apt 装 FFmpeg 超时**（已修）。`Failed to fetch …/libllvm19_19.1.7-3%2bb1_amd64.deb Connection timed out`，`exit code: 100`，ffmpeg 要拉 ~200 个包。给 apt 显式加 `-o Acquire::Retries=5 -o Acquire::http(s)::Timeout=30`（默认不重试），pip 侧加 `PIP_RETRIES=10` / `PIP_TIMEOUT=60`。

- `mediaflow:1.8.4` / `:latest`（**本机 x86_64 原生构建**，`./build.sh` 不带 `--platform`，platform `linux/amd64`）：已构建通过——829.3 MB，id `a8f96c244026`，前端层与 apt 层 CACHED，pip 层重跑通过（0 次重试、无 SIGPIPE 噪声）。本地实例现在跑的就是这个镜像（容器 `mediaflow`，`127.0.0.1:8999`，healthy，`/health` `{"status":"ok"}`，`/openapi.json` 报 `1.8.4`，容器内 11 个 pin 全核对通过，`/asr/tasks?limit=3` 200）。
3. **pip 层被代理断链**（已修）。原生构建里 `RUN pip install -r requirements.txt` 报 `ProtocolError: Connection broken: BrokenPipeError(32, 'Broken pipe')`，`exit code: 2`——代理在**下载中途**断链，不是请求超时，所以 `PIP_RETRIES` 帮不上（它只重发 HTTP 请求，不管传到一半的响应体）。修法与 npm 层同构：整层 `for attempt in 1..5` 重试，且每次成功后按 `requirements.txt` 的 pin 逐个核对（`pip freeze` + grep，`${name%%\[*\]}` 剥掉 `uvicorn[standard]` 的 extras）。核对本身先验证过两个方向：真镜像里 11 个 pin 全过；把 pin 改成 `pydantic==9.9.9` 时层失败（实测 5 次重试后 `exit 1`）。本轮构建日志里它确实**重试了 1 次**再成功（第 2 次 `Successfully installed … uvicorn-0.48.0 …`）。
   这个核对本身还带出一个缺陷并一并修掉：原先写成 `pip freeze | grep -qiE …`，`grep -q` 命中即退出，`pip freeze` 收到 SIGPIPE，于是构建日志在正确的判定旁边多出一段 `pip/_internal/commands/freeze.py … BrokenPipeError` 的 traceback——判定没错，但把真结论埋在噪声下面，而且每次核对都要跑 11 次 `pip freeze`。改为一次 `installed="$(pip freeze)"` 存进变量、逐个 pin 用 `printf '%s\n' "$installed" | grep -iE … >/dev/null` 匹配（grep 读完整个输入才退出，不会断管）。修后在真镜像里跑：exit 0、`pin not satisfied` 0 条、无 traceback；反向对照（把 pin 改成 `pydantic==9.9.9`）：exit 1、1 条 `pin not satisfied`、5 次重试消息、同样无 traceback。随后 `./build.sh` 重建：pip 层实跑 26.5s 通过，重试 0 次、无 SIGPIPE 噪声。
- `app/web` 静态产物本身与 HEAD 前端代码一致（早前用仓库现存的 `frontend/node_modules` 离线 `npm run build` 逐字节复现过，1.8.3 后新哈希 `index-jSiCNCs6.js`）。
- CI 的 `docker` job 对这同一个 Dockerfile 是全绿的（run 39917143539 `test (3.11)` `test (3.12)` `frontend` `docker` 全 success），说明 Dockerfile 本身没有环境无关的错误，本机失败的是这条代理链路。
- **构建架构**：`./build.sh` 不带参数时按 `uname -m` 选本机架构，`--platform` 只有在显式传入时才加进 `docker build`——本机（WSL2 x86_64）默认就是 `linux/amd64`，上面的镜像即由此产出。**本轮的 arm64 交叉构建已中止**：现场目标是鲲鹏 920（`ONSITE_DEPLOY.md` 明确写「不要在 WSL2 上构建带去现场的镜像」），交付包应在现场同架构的 ARM 打包机上 `./build.sh --save` 产出，不在本机做 qemu 模拟构建（qemu 下 pip/apt 层的网络耗时是原生的数倍，本轮实测 arm64 apt 层跑了 20 分钟以上）。中止时残留的 arm64 镜像标签 `mediaflow:1.8.3`（id `379f3fb6755f`，222 MB，`arch=arm64`）已 `docker rmi` 删除，本机 `mediaflow:1.8.4` / `:latest` 现在只有 amd64 一份。
- **交叉架构护栏**（`build.sh`）：显式传入的 `--platform` 与 `uname -m` 不符时先警告「每一层在 QEMU 模拟下执行、交付包应在同架构打包机上产出」；若 daemon 连对应模拟器都没注册，直接失败并给出注册命令。实测：本机传 `--platform linux/amd64` 与宿主同架构，护栏整块跳过、无警告；传 `--platform linux/riscv64` 与 `--platform linux/arm64` 都是两条警告后 `exit 1`。`PLATFORM_SET` 只在参数里真的出现 `--platform` 时才置 1，不带参数的原生构建不受影响。
- 护栏第一版判定用的是 `docker buildx inspect default` 的 `Platforms:` 行，实测**不可靠**：本轮撤掉 qemu 之后该行仍列 `linux/arm64`（builder 缓存的能力报告），而最小 arm64 构建（`FROM python:3.12-slim-trixie` + 一条 `RUN python -c ...`）已经 `exec format error`。改为读 `/proc/sys/fs/binfmt_misc` 的注册表（`arm64 → qemu-aarch64`，`amd64 → qemu-x86_64`），目录不可读时才退回 buildx。撤 qemu 后实测 `arch_emulated arm64` 返回 1（此前会返回 0）。
- 本轮为试 arm64 装的 `tonistiigi/binfmt --install arm64` **已撤掉**：`docker run --privileged --rm tonistiigi/binfmt --uninstall qemu-aarch64`，`/proc/sys/fs/binfmt_misc` 现在只剩 `WSLInterop` / `python3.12`。

- **不要用 `v1.8.1` / `v1.8.2` tag 构建交付**（分别带历史列表 bug 和标题缺口）。

### 版本
发布 **1.8.4**（`app/main.py`、`frontend/package.json` + lock、`build.sh`、`docker-compose.prod.yml` 四处一致；`DEPLOY_ONSITE.md` / `ONSITE_DEPLOY.md` / `README.md` / `README.en.md` 的 tarball 名同步）。内容是本轮的三条构建层修复（npm 可选依赖、apt 超时、pip 断链）加 `build.sh` 的跨架构护栏；前端与后端代码相对 1.8.3 无改动。1.8.4 的构建产物是 `a8f96c244026`（829.3 MB，`linux/amd64`）。**不要用 `v1.8.1` / `v1.8.2` / `v1.8.3` tag 构建交付**：前两个带功能 bug，`v1.8.3` 只有 pip 层断链这一个构建缺陷，功能上可用，但要少一次手工重试就用 `v1.8.4`。

## 1.8.5：解析/内存上界 + 文档职责链（2026-10-23，同日第五轮）

### 这一轮做了什么（对应「你感觉他需要改进吗」那份清单的 1/2/3/6/7）
- **①文件转写事件历史上界**：`app/services/stream_manager.py` 的 `_Task.events` 从 `list` 改 `deque(maxlen=512)`（`_EVENT_HISTORY_SIZE`），与 `RealtimeManager` / `StreamTranscribeManager` 取同一值。此前它在 `task_ttl_seconds`（默认 1h）保留窗口里无界增长。用户可见文本不变：完整结果在归档里，`useFileTask` 按 `segment_id` 去重并在终态时重新 `GET /asr/file/{id}/result`，上界只缩短断线重放窗口。
- **②`openai_compat` 真正读 verbose_json**：`_build_form` 本来就请求 `timestamp_granularities=["word","segment"]`，但 `_parse_response` 只读 `words[]`。现在加 `_speaker_of()`（`speaker` / `speaker_id` / `speaker_label` 三种写法），逐词读 speaker；`words[]` 为空时用 `segments[]` 填词级条目（只在没有词级时间时填，不把细的换成粗的）；`text` 空时从词文本重建。新增 `tests/test_openai_compat_provider.py`（5 条）。**局限已写进 CHANGELOG/README**：现场那份 `asr-deploy-code/` 的 HTTP verbose_json 分支只返回 `{text, language, duration, infer_ms, rtf, task, backend, device, raw}`（`asr-deploy-code/routers/http.py`），没有 `words[]` / `segments[]`，所以这条对那个上游无可见收益。
- **③版本号落点守门**：新增 `tests/test_version_consistency.py`（7 条），从 `app/main.py` / `frontend/package.json` / `build.sh` 的 `DEFAULT_TAG` / `docker-compose.prod.yml` 的 `image:` / `CHANGELOG.md` 顶部条目各读一个版本号并断言五者相等。守的正是 CHANGELOG 自己记录的那次漂移（`1.3.1` 只出现在 `frontend/package.json`）。
- **⑥测试覆盖**：后端补 `tests/test_stream_manager.py` 2 条（有界尾巴 + 先尾巴后实时）、`tests/test_realtime_ws_provider.py` 4 条（未 finalize 的段是压缩屏障、压缩前后文本逐字符相等、空 final 不留空洞、CJK 补格规则在前缀接缝处成立）。前端把 `RealtimeRecorderPanel.tsx` 里的 5 个未导出纯函数 + 2 个常量抽到 `frontend/src/lib/realtimeRecording.ts`（91 行），组件 851 → 790 行，新增 `realtimeRecording.test.ts`（19 条）。`npm run lint` 与 `npx tsc -b` 干净。
- **⑦文档职责链**（本轮最大的一块，详见 CHANGELOG 的 1.8.5 条目）：五份手册此前把 `realtime_http` + `http://<IP>:8023` 写成现场实时识别的通用配法，而仓库里两份 ASR 服务协议不同——`deploy/qwen3-asr-npu/streaming_server/` 是 HTTP+SSE 的 `/session/...`，现场真实服务 `asr-deploy-code/` 只有 `WebSocket /v1/asr/stream`、没有任何 `/session/...`。现在每份文档顶部写「这份文档管什么」并互相指路；`ONSITE_DEPLOY.md` / `deploy/qwen3-asr-npu/DEPLOY.md` / `deploy/qwen3-asr-npu/docker-compose.yml` 加路线 A/B 对照表；`STREAMING_ONSITE_DEPLOY.md` 加「适用范围」；`DEPLOY_ONSITE.md` 新增实时识别配置小节 + 三条排错行。`deploy/qwen3-asr-npu/OFFLINE_DEPLOY.md` 合并进 `DEPLOY.md` §三 并压成 23 行指路牌（原因：同一份镜像两处写 4-5GB / 8-10GB，实测压缩产物 6,893,164,068 字节）。顺带修三处既有缺陷：`ONSITE_DEPLOY.md` 末尾未闭合的代码围栏、`DEPLOY.md` 两个 `## 六` 标题、端口冲突示例把 ASR 映射到同一份 compose 里流式服务自己的 8023。
- **已知缺口（未做，已写进文档）**：仓库没有 `asr-deploy-code/` 的 NPU Dockerfile（仓库总共 4 个 Dockerfile，CUDA 版是 `deploy/qwen3-asr-cuda/Dockerfile`），走路线 B 上 NPU 要现场自建。

### 基线与实例状态
- 后端 `python3 -m pytest -q` → **294 passed**（原 276，+18：5 provider + 2 stream_manager + 7 version + 4 realtime_ws）。
- 前端 `npm test` → **22 files / 154 passed**（原 21 files / 135 tests）；`npx tsc -b` exit 0；`npm run lint` 干净（上一轮记录的 `MonitorView.tsx:53` setState-in-effect 与 `RealtimeView.test.tsx:71` 未使用 `opts` 两个既有错误本轮未复现）。
- 8999 上跑的仍是 `mediaflow:latest`（= 1.8.4 镜像 `a8f96c244026`），`/openapi.json` 报 `1.8.4`——本轮改动**尚未构建进镜像**，本轮也未重建镜像（改动不含依赖与 Dockerfile 层变化）。要实地跑 1.8.5：`./build.sh --up`（原生 amd64）或 `./build.sh --save` 产出交付包。

### 版本
发布 **1.8.5**（`app/main.py`、`frontend/package.json` + lock、`build.sh`、`docker-compose.prod.yml` 四处一致；`DEPLOY_ONSITE.md` / `ONSITE_DEPLOY.md` / `README.md` / `README.en.md` 的 tarball 名同步）。本轮不含依赖变更、不含 Dockerfile 层变更，交付镜像相对 1.8.4 的差异只有后端解析/内存上界与前端模块拆分。1.8.4 的构建产物仍是 `a8f96c244026`（829.3 MB，`linux/amd64`）；**1.8.5 的构建产物需要在打包机上产出后才能核对**。`ONSITE_DEPLOY.md` 的交付清单里 `mediaflow-*.tar.gz` 那行的「~?」填成实测 ~0.2G（`docker save 1.8.4 | gzip` = 225,434,919 字节；`docker images` 报的 870MB 是解压后层大小）。

## 1.8.6：prod compose 的 bind mount 身份（2026-10-23，同日第六轮）

### 这一轮做了什么
- **`docker-compose.prod.yml` 补上 `user:` 行**（本轮唯一的功能性缺陷，也是唯一交付相关的一处）：1.8.1 只给 `docker-compose.yml` 加了 `user: "${MEDIAFLOW_UID:-10001}:${MEDIAFLOW_GID:-10001}"`，prod 文件漏了。本机实测复现：`.env` 写 `MEDIAFLOW_UID=1000`、`temp`/`outputs`/`config` 属于 uid 1000 时，`./build.sh --up`（`start_built_image()` 走的正是 prod 文件）崩溃循环——`app/main.py:420 _check_volume_access` 三条 `data volume ... not writable by uid 10001` + `RuntimeError` → `ERROR: Application startup failed. Exiting.`，`restart: unless-stopped` 让它每轮重打印同一条 chown 命令。修后 `docker compose -f docker-compose.prod.yml config` 报 `user: 1000:1000`，prod `up -d` → `health=200`、`/openapi.json` 报当轮版本。顺带确认 `config/runtime_config.json is unreadable` 这条噪声日志是同一根因（0600 文件属于 uid 1000，uid 10001 读不到）。
- **测试**：新增 `tests/test_compose_volume_identity.py`（4 条）——两份 compose 都要有这行、`.env.example` 要写出这两个变量、写了 `chown` 的文档必须同时给出变量这条出路。后端 `pytest -q` → **298 passed**（原 294）。
- **文档**：`DEPLOY_ONSITE.md`（第 3 步警告后 + 排错表那一行）、`ONSITE_DEPLOY.md:272` 块、`README.md`「数据卷属主」引文、`README.en.md` 对应段落，四处补 `MEDIAFLOW_UID=<属主 UID>` / `MEDIAFLOW_GID=<属主 GID>`（`id -u 部署用户`）这条替代路线。
- **未做的一件事（有意）**：没有改 prod 的 `network_mode: host` 默认行为。仓库 `.env` 是 `HOST=0.0.0.0` + `ACCESS_TOKENS=`（空），prod 用 host 网络意味着在本机所有网卡上无鉴权监听。本轮验证 prod 启动时用的是 `HOST=127.0.0.1 docker compose -f docker-compose.prod.yml up -d`，验证完 `down` 并恢复 loopback 的开发实例。`HOST` 来自 `.env`，文档已要求先设 `ACCESS_TOKENS` 再 `HOST=0.0.0.0`，所以不动默认值。

### 基线与实例状态
- 后端 **298 passed**；`ruff check app tests` 干净。前端本轮无改动（`npm test` 仍是 22 files / 154 passed、`tsc -b` 与 `lint` 干净——本轮未重跑，因为前端代码零改动）。
- 本地 8999 实例：1.8.5 镜像（`mediaflow:1.8.5` = `mediaflow:latest`，id `718bc955548b`，829.3 MB，`linux/amd64`）已在 `127.0.0.1:8999->8999` 上 healthy 运行过并核对 `/openapi.json` = `1.8.5`。**本轮改动不进镜像**（只动 compose 文件、文档与测试），所以 8999 报告的版本号仍会落后于仓库版本，直到重新 `./build.sh`。

### 版本
发布 **1.8.6**。因为本轮不含后端/前端代码与 Dockerfile 层变更，**只替换 `docker-compose.prod.yml` 就能修掉现场的启动崩溃循环**，不必重新 `docker load`。交付命令照旧：在与现场同架构的打包机上 `./build.sh --save` → `mediaflow-1.8.6-<架构>.tar.gz`（~0.2G），现场 `docker load -i mediaflow-1.8.6-arm64.tar.gz && docker compose -f docker-compose.prod.yml up -d`。

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
