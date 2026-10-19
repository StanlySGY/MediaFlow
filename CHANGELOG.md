# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
版本号的落点：`app/main.py` 的 FastAPI `version`、`frontend/package.json`、`build.sh` 的 `DEFAULT_TAG` 与 `docker-compose.prod.yml` 引用的 `mediaflow:<版本>` 四处保持一致。

仓库里真实出现过的版本落点只有 `0.1.0 → 1.2.0 → 1.3.0 → 1.4.0 → 1.4.1 → 1.7.0 → 1.7.1 → 1.7.2 → 1.7.3`：`1.5.x` / `1.6.x` 从未使用；`1.3.1` 只在 2026-07-28 一次提交的 `frontend/package.json` 里出现，随即被 `1.4.1` 覆盖，`build.sh` / `app/main.py` / `docker-compose.prod.yml` 三处从未跟进，因此不单独列为一个发布。首个 git tag 是 `v1.7.3`（2026-10-19 切出，版本号本身落点在 2026-09-23 的 `a34b62d`）。

## [1.7.3] - 2026-10-19

### 新增
- **配置档案**：可保存多个 ASR endpoint，文件转写与实时识别分别选择使用哪一个（`GET/POST /asr/config`）。
- **模型名探测**：配置页可直接从上游拉取可用模型名并回填，实时侧同样支持。
- **上传前预检**：先校验扩展名与体积再决定是否提交，误选文件不再先取消正在运行的任务、再在传输中途收到 413。
- **失败协议**：前端展示服务端返回的 `error` / `error_code` / `hint` / `retryable`；仅在 `retryable` 且失败文件仍在本地时提供「重试」。
- **容量指示**：实时页显示「在用 N/M 路」，上限取自 `/asr/config`。
- **URL 可寻址**：`hashRoute` 驱动视图与历史筛选，链接可直接分享、刷新后定位到同一位置。
- **实时归档进历史页**：已结束的实时会话在历史页以只读转写弹窗呈现，保留时长按 `OUTPUT_TTL_SECONDS` 说明。
- **中止 ≠ 清空**：「中止」停止识别但保留已识别出的分片，仍可导出字幕。

### 变更
- 文件 ASR 入口统一到 `/asr/file`：`POST /asr/file`、`GET /asr/file/{id}`、`.../events`、`.../result`、`.../subtitle`。`/asr/task` 的这五个孪生接口标为 **deprecated**（仍可用）。
- `cancel`、`delete`、`segments/{id}/raw` 三个端点**只有 `/asr/task` 拼写**，`/asr/file` 侧无对应路径。
- 实时「录音」与「API 调试」拆成两个视图，不再每推一块音频就查一次会话状态。
- UI 全面改为克制中性风格（单一强调色 + 中性灰阶），六个视图统一。
- 默认端口回到 `8080`；录音失败给出可读的原因说明。

### 修复
- 不再在每次页面加载时探测上游 ASR。
- `interrupted`（服务重启导致中断）任务保留为可见、可重新提交。
- 运行时配置写入失败时回退到备份，并保留无效字段的报告。
- Docker 前端构建阶段改用 glibc 基础镜像，修复 rolldown 绑定缺失导致构建失败。
- 构建不再要求 `docker buildx` / `docker compose` 插件；`--save` 产物改用 BuildKit 导出，现场 `docker load` 可加载。

### 安全
- SSE 的 `?token=` 兼容路径保留但注明会进入访问日志；浏览器 `EventSource` 使用短期 HttpOnly cookie。
- `config/runtime_config.json` 写入后权限收紧为 `0600`。

## [1.7.2] - 2026-09-15

### 新增
- 标准 SSE 流新增 `delta` 字段，前端可增量渲染而不重绘整段文本。
- 调用监控页展示实时链路的调用记录。
- partial 节流可配置。

### 性能
- 实时首字延迟下降。
- 并发实时会话上限收紧为 4（原 8）：上游推理串行，6 路尾延迟 >4s、8 路仅 1/8 能在 20s 内拿到终稿。
- 已结束的会话不再占用并发额度。

### 修复
- 并发超限的 429 在页面上显示为一句说明，而不是原始 JSON。
- realtime delta 对齐 UTF-16 偏移。
- 空结果不再把 dataclass repr 泄漏成转写文本。
- ASR 语言码归一化；推理池加上界。

## [1.7.1] - 2026-08-19

### 修复
- 流式健康检查接受 Qwen3-ASR `/readyz` 的 status 字段。

## [1.7.0] - 2026-08-19

### 新增
- `realtime_ws` provider：直连 Qwen3-ASR 原生 WebSocket `/v1/asr/stream`，浏览器 WebM/Opus 由每会话常驻 FFmpeg 转为 16k 单声道 PCM，partial/final 即时转发。
- 面向现场的部署手册（完整版 + 仅流式版）与 `docker-compose` 变体。

### 修复
- 浏览器 `EventSource` 使用完整绝对 URL 而非相对路径。

## [1.4.1] - 2026-07-28

### 修复
- `DOCKER_BUILDKIT=0` 改由 `build.sh` 以环境变量注入，并从 `Dockerfile` 的 `FROM` 之前移到之后。
- 浏览器 `EventSource` 使用完整绝对 URL 而非相对路径。

## [1.4.0] - 2026-06-02

### 新增
- 音视频无损合并（`/media/concat`，concat demuxer + `-c copy`，不转码）与合并页 `ConcatView`；项目由 AudioFlow 更名为 MediaFlow。
- air-gapped 交付路径：`docker-compose.prod.yml` + `build.sh --save/--platform`，现场 `docker load` 上线。
- 标准 ASR 流式网关、流式文件转写端点，标准 ASR SSE 事件形状统一。
- ASR 调用监控面板、浏览器实时录音测试页。
- 说话人分离解析：解析上游返回的 speaker 标签与 `speaker_id`，文件与实时链路都带上 speaker。
- Qwen3-ASR 昇腾 NPU 现场部署配置与文档（官方 Ascend vLLM 镜像）、流式服务与离线交付文档、`.env` 配置文件与中文注释。
- FFmpeg 单进程超时与切片并发上限。
- Vitest + Testing Library 前端测试、CI 前端构建、ruff 全仓清 F401、MIT LICENSE。

### 修复
- 解析 vLLM Qwen3-ASR 的响应格式（`language<asr_text>文本`）。
- `input_audio` 补上 `format` 字段以兼容 vLLM；去掉 vLLM 不支持的 `asr_options`。
- DashScope chat audio 请求格式；chat ASR 不再注入 system prompt。

## [1.3.0] - 2026-06-01

### 新增
- 分片级字幕校对、响应式与可访问性打磨。

### 修复
- `.bar` 类名冲突导致实时声波动画变形。

## [1.2.0] - 2026-05-28

### 新增
- React + Vite 前端替换单文件 UI；多阶段 Docker 构建与 `build.sh`。
- 实时 pipeline（base64 chunk + SSE）与侧边栏多 tab Web UI。
- 可编辑的运行时配置：`POST /asr/config` + 持久化覆盖 + 表单页面。
- `openai_chat_audio` provider（vLLM Qwen3-ASR / 多模态 chat 端点）。
- host-network compose 变体（受限宿主）；浅色 new-api 风格主题 + 中文上手引导。

### 变更
- 构建产物与工具 sidecar 不再入库，部署路径统一为 Docker。

### 修复
- 默认端口 8000 → 8999（8000 被占用）。

## [0.1.0] - 2026-05-27

首个可用版本（项目名仍为 AudioFlow-ASR）：长音频切分 + OpenAI 兼容 ASR 转写 + 多订阅者 SSE 流式推送，随带 provider 抽象、Word 时间戳、SRT/VTT 字幕导出、可选令牌鉴权、可选热词偏置，以及由 `/` 提供的单文件 Web UI 与 CI。
