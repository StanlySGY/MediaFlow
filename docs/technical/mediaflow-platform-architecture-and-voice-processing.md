# MediaFlow 音视频处理、ASR 接入与实时转写平台技术方案

> 项目：MediaFlow
> 国大项目交付用途：本人负责的语音输入/识别链路及音视频处理工程化成果
> 核对基线：main / 117552146254（2026-10-25，版本记录 1.8.7）
> 说明：本文只描述已提交的 1.8.7 代码；不把当前工作区尚未提交的改动写成已交付能力。

## 1. 项目定位：MediaFlow 是什么

**MediaFlow 是面向音视频文件转写和实时语音识别的业务处理与工程化平台，不是 ASR 基座模型，也不等同于 Qwen3-ASR。**

它把上游一次性的语音识别能力封装成可供用户使用的应用：文件上传、长音频切分、ASR Provider 调度、分片结果拼接、字幕生成、实时会话、事件推送、任务历史、人工校对、配置管理和离线部署。

ASR 模型推理由外部或配套上游服务提供，MediaFlow 通过 Provider 接口接入多种服务。Qwen3-ASR 只是其中一种可选上游，不能把 MediaFlow 的整体能力归结为 Qwen3-ASR 的能力。

## 2. 整体架构与数据流

### 2.1 文件转写

浏览器/Web UI → FastAPI 文件任务接口 → 上传准入与音频预算 → FFmpeg 音频探测和长音频切分 → ASR Provider 调度 → 分片结果归并和时间戳校准 → 字幕整理及结果持久化 → SSE 进度/结果事件 → 浏览器播放联动校对、编辑和导出。

### 2.2 实时识别

浏览器 MediaRecorder → MediaFlow 创建实时会话 → 连续音频 chunk 上传 → RealtimeASRProvider 适配层 → 上游实时 ASR（WebSocket 或 HTTP+SSE）→ 统一 online/final/error/done 事件 → MediaFlow SSE → 浏览器实时显示和会话收尾。

MediaFlow 负责应用侧会话、协议适配、事件生命周期、资源清理和 UI 状态；上游模型服务负责声学识别及模型侧 endpointing 等能力。

## 3. MediaFlow 自身的主要能力与改造

### 3.1 长音频文件处理与并发调度

- 支持文件上传及异步任务处理，不要求把整段长音频作为单个请求发送给上游。
- app/services/splitter.py 提供 fixed、silence、overlap 等切分策略，并通过 asyncio 并发闸门控制分片调用。
- app/services/audio_budget.py 先探测音频时长，再判断是否需要切分；分批调用时共用 ASR 并发上限，并将分片时间戳映射回整段音频坐标。
- app/services/asr/inline_budget.py 对只接受内联 Base64 音频的 Provider，在读取/编码大文件前检查时长和字节上限，避免内存膨胀后才拒绝。
- app/services/asr/call_limiter.py 统一约束调用容量；容量不足时返回可操作的拒绝信息，而不是让请求无限排队。

### 3.2 分片结果归并与字幕生成

- app/services/merger.py 在上游提供 word 级时间戳时，按切片重叠区中点裁剪重复部分。
- 上游没有 word 时间戳时，使用最长公共子串等文本去重策略处理相邻片段，降低重叠切片造成的重复文本。
- 处理中文文本边界，避免简单拼接产生不自然空格。
- app/services/subtitles.py 将识别结果整理为 SRT/VTT 等字幕格式。时间戳和字幕粒度依赖上游实际返回的数据；上游没有 word 时间戳时，不能宣称具备真实的 word 级时间轴。

### 3.3 文件任务、事件推送与恢复

- app/services/stream_manager.py 管理上传后的文件任务、分片进度、结果、SSE 事件订阅和回放。
- app/services/stream_transcribe_manager.py 管理流式转写相关任务事件。
- SSE 支持多订阅者和有限事件历史，页面刷新或重新订阅后可获取任务状态与已有事件。
- 任务输出持久化到 outputs/，并保留可查询结果；进程异常退出造成的中断任务会在启动恢复逻辑中标记为 interrupted。
- 失败分片可隔离并按策略重试，避免个别分片失败直接丢失全部任务结果。

### 3.4 实时语音识别与 Provider 抽象

MediaFlow 将文件 Provider 与实时 Provider 分开注册，适配不同上游协议：

| Provider | MediaFlow 侧职责 | 识别模式 |
|---|---|---|
| openai_compat | 调用 OpenAI 风格 audio transcription 接口并解析结果 | 整段/分片文件转写 |
| openai_chat_audio | 通过 chat completions 的 input_audio 结构提交音频 | 整段音频识别，不等同实时流式解码 |
| realtime_ws | 连接原生 WebSocket ASR 服务，接收 partial/final 事件 | 实时流式 |
| realtime_http | 对接统一的 HTTP 会话 + SSE 事件协议 | 实时流式 |
| realtime_offline | 接收完整录音，结束后调用文件 Provider，再将结果转换为统一事件 | 接口兼容模式，不是真正实时解码 |
| realtime_mock | 为 UI/API 测试提供模拟事件 | 测试用途 |

实时会话 API：
- POST /asr/realtime/session：创建会话。
- POST /asr/realtime/{id}/audio：上传音频 chunk。
- GET /asr/realtime/{id}/events：订阅 SSE 事件。
- POST /asr/realtime/{id}/end：结束会话。
- DELETE /asr/realtime/{id}：关闭会话并释放资源。

### 3.5 浏览器音频与上游实时协议适配

浏览器 MediaRecorder 常见输出为 WebM/Opus，而部分模型服务只接受 PCM 帧。app/services/asr/realtime_ws.py 为每个会话管理 FFmpeg 转码进程，将输入转换为 16 kHz、单声道、16-bit PCM，并按约 200 ms 帧发送给 WebSocket 上游。转码和会话桥接由 MediaFlow 承担，不是 Qwen3-ASR 模型本身的功能。

### 3.6 上传、会话和调用资源保护

- app/services/upload_gate.py 在读取请求体前检查上传并发和磁盘空间，超限时返回明确错误。
- audio_budget.py 和 inline_budget.py 限制长音频及 Base64 内联音频的资源开销。
- app/services/realtime_manager.py 管理实时会话数量、累计音频量/时长、结束后的资源释放、取消与 drain 生命周期。
- call_limiter.py 统一约束上游调用并发和容量拒绝。
- 任务终止、客户端断连、上游异常和进程退出时均有对应清理/恢复路径。

### 3.7 Web 控制台与人工校对

Web UI 不只是模型调试页，包含文件任务、实时识别、服务配置和历史任务等工作区：
- 上传进度和分片级任务进度。
- 音视频播放与转写文本/字幕时间轴联动。
- 分片查看、双击校对、文本编辑、撤销和导出。
- 实时识别 partial/final 结果、chunk/event 统计和录音电平展示。
- 服务配置在线维护、上游连通测试、Provider/模型选择和原始响应查看。
- 历史任务查询、结果回放，以及移动端响应式布局。

### 3.8 音视频后处理与部署运维

- POST /media/concat 支持同容器/编码参数的多段音频或视频通过 FFmpeg concat demuxer 和 -c copy 无损拼接；不支持混格式拼接或任意转码。
- Docker 提供部署封装；支持离线镜像交付、数据卷持久化、非 root 运行、数据卷权限检查、受保护的 API 文档入口和优雅停机。
- 任务、SSE 订阅和实时会话状态在单进程内存中，当前架构要求单 worker 运行，不应直接增加 Uvicorn 多 worker 或声称已具备水平扩展能力。

## 4. Qwen3-ASR 在 MediaFlow 架构中的位置

Qwen3-ASR 是 MediaFlow 可接入的一个 ASR 上游，而不是 MediaFlow 的主体：
1. MediaFlow 适配层：openai_chat_audio 用于 OpenAI 兼容的整段音频调用；realtime_ws 用于原生 Qwen3-ASR WebSocket 实时接口，并负责浏览器音频到 PCM 的桥接。
2. 上游模型服务部署：仓库中的 deploy/qwen3-asr-cuda/、deploy/qwen3-asr-npu/ 和 asr-deploy-code/ 提供配套服务部署/验证材料，分别面向 CUDA 与昇腾 NPU 环境。

Qwen3-ASR 部署参数、CUDA/NPU 容器和协议细节见配套文档《MediaFlow 对接 Qwen3-ASR 的 CUDA/NPU 部署与实时识别适配说明》。不能把这些模型服务部署材料等同于 MediaFlow 的全部功能，也不能把模型本身的推理效果归为 MediaFlow 自研。

## 5. 关键代码路径

| 模块 | 代码路径 |
|---|---|
| FastAPI 应用入口和生命周期 | app/main.py |
| API 路由和文件/实时任务端点 | app/api/routes.py |
| 配置和运行参数 | app/config.py |
| 文件 ASR Provider 协议与注册 | app/services/asr/base.py、registry.py |
| OpenAI transcription Provider | app/services/asr/openai_compat.py |
| Chat Audio Provider（含 Qwen3-ASR 兼容入口） | app/services/asr/openai_chat_audio.py |
| 实时 Provider 协议和错误分类 | app/services/asr/realtime_base.py |
| 实时 Provider 注册 | app/services/asr/realtime_registry.py |
| 原生 WebSocket 适配和 FFmpeg 桥接 | app/services/asr/realtime_ws.py |
| HTTP+SSE 实时适配 | app/services/asr/realtime_http.py |
| 文件 ASR 兼容实时模式 | app/services/asr/realtime_offline.py |
| 长音频切分 | app/services/splitter.py |
| 分片归并和去重 | app/services/merger.py |
| 长音频调用预算 | app/services/audio_budget.py |
| 内联音频预算 | app/services/asr/inline_budget.py |
| ASR 调用容量限制 | app/services/asr/call_limiter.py |
| 上传准入 | app/services/upload_gate.py |
| 文件任务与 SSE 事件 | app/services/stream_manager.py、stream_transcribe_manager.py |
| 实时会话生命周期 | app/services/realtime_manager.py |
| ASR 调用监控 | app/services/asr_monitoring.py |
| 字幕生成 | app/services/subtitles.py |
| FFmpeg 封装 | app/services/ffmpeg_service.py |
| 前端文件转写 | frontend/src/hooks/useFileTask.ts、frontend/src/components/HistoryView.tsx |
| 前端实时录音和会话交互 | frontend/src/components/RealtimeRecorderPanel.tsx、RealtimeView.tsx |
| 前端音频电平和校对 | frontend/src/components/AudioLevelMeter.tsx、HistoryTranscriptDialog.tsx |
| Qwen3-ASR CUDA 部署 | deploy/qwen3-asr-cuda/ |
| Qwen3-ASR NPU 部署 | deploy/qwen3-asr-npu/ |
| 配套 ASR 模型服务代码 | asr-deploy-code/ |

## 6. 仓库中可追溯的代表性提交

以下是仓库历史中能追溯到的代表性产品和工程能力提交；它们说明 MediaFlow 自身持续演进，不代表模型研发：
| Commit | 日期 | 内容 |
|---|---|---|
| 5a515c2 | 2026-05-27 | 初始长音频 ASR 任务、分片和并发处理 |
| 900fd06 | 2026-05-27 | 多订阅者 SSE、事件保留/回放、结果持久化和 CI |
| cd543de | 2026-05-27 | Provider 扩展点、时间戳、字幕和鉴权 |
| b3fb2bb | 2026-05-27 | 服务配置、上游探测、单任务参数覆盖、分片时间信息和原始响应查看 |
| 2c00051 | 2026-05-28 | 实时 Base64+SSE pipeline 和多标签 Web UI |
| 1449a2f | 2026-05-28 | React/Vite 前端、多阶段 Docker 构建 |
| 7ea684c | 2026-06-11 | 标准 ASR 流式网关 |
| 9a212ff | 2026-06-12 | ASR 调用监控面板 |
| 518353d | 2026-08-19 | 原生 Qwen3-ASR WebSocket Provider（可选上游接入） |
| ff7605f | 2026-09-03 | 六项实时 ASR 链路优化 |
| 2de9240 | 2026-10-20 | 历史索引、上传准入和运维加固 |
| aa8abf2 | 2026-10-20 | 输入电平、可撤销校对和移动端优化 |
| 1175521 | 2026-10-25 | 全文件 ASR 调用预算与可操作的容量拒绝 |

## 7. 能力边界与不能夸大的内容

- MediaFlow 核心应用不内置 ASR 模型权重，不自行训练或推理 Whisper、Qwen3-ASR、FunASR 等模型；识别能力依赖配置的上游服务。
- 上游没有返回 word 时间戳时，不能声称 MediaFlow 能生成真实的 word 级时间轴；会退化到分片级文本及去重逻辑。
- 说话人分离、标点、翻译和模型端点检测主要依赖上游，MediaFlow 负责接收、映射或展示上游给出的信息。
- realtime_offline 是录音结束后再转写并模拟事件，不应称为模型实时解码。
- 单进程内存状态意味着当前版本不支持直接多 worker 水平扩展。
- 本说明中的代码能力不等于已经在国大现场发布；需要镜像 digest、构建源 Commit、运行配置和验收记录建立产品同步证据。

## 8. 验证情况与当前未提交改动

- 1.8.7 基线中存在文件任务、实时 Provider、事件管理、预算限制、上传准入和前端交互的测试入口；本次文档复核未重新执行完整测试套件，因此不标记为本轮测试通过。
- 当前本地工作区另有 15 项未提交/未跟踪变更，涉及任务存储、事件会话、历史索引和流处理模块。它们不包含在本文 main / 117552146254 的已提交基线结论中；在单独完成 diff 审查和回归测试前，不应把它们列为已交付成果，也不应随文档一并提交。

## 9. 对国大项目能力清单的建议表述

建议登记为：**MediaFlow 音视频处理与 ASR 接入平台**。主要贡献是长音频处理、ASR Provider 适配、文件任务与实时识别会话、事件推送与恢复、分片拼接和字幕校对、容量/资源保护、前端操作台及离线运维适配。

Qwen3-ASR CUDA/NPU 服务及其实时 Provider 接入，作为其中一个专项集成项列出；不要把 MediaFlow 写成 Qwen3-ASR 模型项目，也不要把上游模型能力算作 MediaFlow 自研。
