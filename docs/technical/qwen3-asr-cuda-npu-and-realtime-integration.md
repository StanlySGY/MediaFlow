# MediaFlow 对接 Qwen3-ASR 的 CUDA/NPU 部署与实时识别适配说明

> 依据：MediaFlow main 分支已提交代码基线 117552146254（1.8.7）。
> 范围：描述仓库内的 Qwen3-ASR 服务部署方案，以及 MediaFlow 对文件/实时识别协议的适配。当前未把现场某个镜像认定为该源码的构建产物。

> **文档定位：本文是 MediaFlow 的 Qwen3-ASR 上游集成专项，不是 MediaFlow 平台总体技术方案。** MediaFlow 自身的长音频处理、任务管理、Provider 抽象、实时会话、SSE 事件、字幕校对、资源保护和 Web 控制台见 [MediaFlow 平台总体技术方案](mediaflow-platform-architecture-and-voice-processing.md)；实时会话与容量保护细节见 [实时识别专题](realtime-asr-and-resource-guardrails.md)。

## 1. 整体架构

系统将 ASR 模型服务与 MediaFlow 的业务/浏览器会话处理分离：

1. Qwen3-ASR 服务加载模型并提供整段转写和实时音频流接口。
2. MediaFlow 通过 Provider 选择整段转写或实时流式后端。
3. 浏览器音频按连续 chunk 送入 MediaFlow；需要时由 MediaFlow 内的 FFmpeg 转为模型服务要求的采样率、声道和 PCM 编码。
4. MediaFlow 将上游 partial/final 结果转换为统一会话事件，并完成调用监控、错误收尾和前端展示。

## 2. Qwen3-ASR 模型服务部署

### 2.1 NVIDIA CUDA 部署

部署目录：deploy/qwen3-asr-cuda/

主要文件：

- Dockerfile
- docker-compose.yml
- README.md

容器以 PyTorch CUDA 运行时为基础，安装 qwen-asr 和 FastAPI/Uvicorn 依赖，复制仓库根目录的 asr-deploy-code/。模型权重通过只读 volume 挂载，不烘焙进镜像，便于按版本替换权重。默认服务对外端口为 8030，容器内端口为 8022。

部署参数支持设备类型、模型目录、精度、语言、VAD、流式 partial、最大会话数和推理并发配置。部署文档给出的默认上限包括 ASR_MAX_CONCURRENCY=2、ASR_PARTIAL_CONCURRENCY=1；调整前需核对目标设备显存和实际负载。

### 2.2 昇腾 NPU 部署

部署目录：deploy/qwen3-asr-npu/

主要文件：

- Dockerfile
- docker-compose.yml
- DEPLOY.md
- OFFLINE_DEPLOY.md

镜像基于 Ascend vLLM 环境，安装 qwen-asr[vllm]，通过挂载的模型目录启动 Qwen3-ASR。权重与镜像分开管理；离线部署文档覆盖镜像导出/传输/导入、模型准备、设备卡号调整和服务验证。

NPU 目录还提供一个可选 streaming_server/，以 HTTP+SSE 会话协议验证音频 chunk 到增量文本的链路。它与原生 WebSocket 端点不是同一协议，不可混用 Provider 类型。

### 2.3 共用 ASR 服务代码

asr-deploy-code/ 是 CUDA 与 NPU 部署所使用的服务代码入口，涵盖 HTTP/OpenAI 兼容接口和原生 WebSocket 实时接口。CUDA Dockerfile 将目录复制到容器内 app/，模型文件在运行时通过挂载提供。

## 3. MediaFlow 的 ASR Provider 适配

| Provider | 下游协议 | 使用场景 |
|---|---|---|
| openai_compat | HTTP POST /v1/audio/transcriptions | 上传完整音频文件并返回转写结果 |
| realtime_ws | WebSocket /v1/asr/stream | 连续录音、实时 partial/final 文本 |
| realtime_http | HTTP+SSE /session/... | 适配采用会话 HTTP/SSE 的流式 ASR 服务 |
| realtime_offline | 录音结束后整段转写 | 将文件转写包装为会话事件，不等同于真正实时解码 |

关键代码路径：

- app/services/asr/registry.py：文件 ASR Provider 注册。
- app/services/asr/realtime_registry.py：实时 Provider 注册。
- app/services/asr/openai_compat.py：OpenAI 兼容整段转写调用。
- app/services/asr/realtime_ws.py：连接 Qwen3-ASR 原生 WebSocket。
- app/services/asr/realtime_http.py：HTTP+SSE 会话协议适配。
- app/services/realtime_manager.py：实时会话生命周期和事件管理。
- app/api/routes.py：对外接口与 Provider 配置。

### 3.1 浏览器音频到 Qwen3-ASR PCM

realtime_ws 支持浏览器连续 WebM/Opus 音频。适配层为每个会话启动常驻 FFmpeg，将音频转换为 16 kHz、16-bit、单声道 PCM，再按约 200 ms 帧发送给 Qwen3-ASR WebSocket。

适配层还负责接收上游事件、合并 partial/final 文本、关联会话和调用 ID，并处理连接失败、上游关闭、会话结束与资源回收。长会话的 final segment 会采用有界窗口并保留已完成前缀，避免无限增长的会话状态占用内存或丢失前文。

## 4. 两种实时流式协议必须区分

### 原生 WebSocket

- 下游端点：/v1/asr/stream
- MediaFlow Provider：realtime_ws
- REALTIME_ASR_BASE_URL 配置为完整 WebSocket URL。
- 上游接受 PCM 音频帧，推送 partial/final 识别事件。

### HTTP+SSE 会话协议

- 创建会话：POST /session
- 推送音频：POST /session/{id}/audio
- 订阅事件：GET /session/{id}/events
- 结束会话：POST /session/{id}/end
- MediaFlow Provider：realtime_http
- 该协议由 NPU 目录下的 streaming_server/ 提供简化验证实现；并非原生 WebSocket 服务的别名。

连接配置必须与实际下游协议匹配；把 SSE 地址配置成 realtime_ws，或把 WebSocket 地址配置成 realtime_http，都会因协议不匹配而无法连通。

## 5. 回归测试入口与交付边界

仓库包含以下测试入口：

- tests/test_realtime_ws_provider.py
- tests/test_realtime_contract.py
- tests/test_realtime_routes.py
- tests/test_realtime_manager.py
- tests/test_realtime_offline_provider.py
- tests/test_realtime_provider.py

本轮没有在当前 Runner 重跑完整测试套件，因此不把现有测试文件表述为本轮已通过。

仓库中的 CUDA/NPU Dockerfile、Compose 和部署文档可证明已提交部署方案；它们不能单独证明目标客户环境已安装、运行或验收。正式交付仍需补充目标环境、设备类型、镜像 digest、模型版本、构建源 Commit 和现场接口验收记录。
