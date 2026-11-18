# 实时 ASR 处理链路与资源保护技术说明

> 依据：仓库 main 分支，已提交基线 117552146254（版本记录 1.8.7）。
> 本文只描述该提交及其之前已提交的实现，不把当前工作区尚未提交的改动写成已交付功能。

## 1. 项目定位与处理链路

MediaFlow 在 ASR 服务调用之外提供音视频任务管理、实时转写、流式结果传输、历史记录和结果导出等应用能力。主要代码入口包括：

- API 路由：app/api/routes.py
- ASR Provider 注册：app/services/asr/registry.py
- Provider 调用和资源限制：app/services/asr/call_limiter.py、app/services/asr/inline_budget.py、app/services/audio_budget.py
- 实时会话：app/services/realtime_manager.py
- 文件/流式处理：app/services/stream_manager.py、app/services/stream_transcribe_manager.py
- 前端实时录音：frontend/src/components/RealtimeRecorderPanel.tsx

## 2. 已提交版本中的关键能力

### 2.1 ASR Provider 接入与实时链路

仓库包含统一的 Provider 注册与选择机制，并区分实时 WebSocket、离线/文件转写等处理路径。相关实现由 Provider registry、realtime manager、stream manager 和 API routes 协同完成。

### 2.2 全文件 ASR 调用预算与容量保护

1.8.7 提交（117552146254）对全文件 ASR 调用增加预算边界，并在容量不足时返回可操作的拒绝信息，避免任务无限占用调用资源。

关键代码路径：

- app/services/asr/call_limiter.py
- app/services/asr/inline_budget.py
- app/services/audio_budget.py
- app/api/routes.py

### 2.3 音频处理内存上限

1.8.5 提交（fa405c4）处理了此前缺少上限的内存路径，并按实际音频处理开销设置预算，降低长音频和高并发请求造成的内存风险。

### 2.4 容器运行身份和部署一致性

1.8.6 提交（db94bc3）使生产 Compose 也遵循 MEDIAFLOW_UID，改善宿主机挂载文件的用户/权限一致性。相关说明位于部署文档与生产 Compose 配置中。

## 3. 验证入口

仓库已包含以下测试：

- tests/test_realtime_ws_provider.py
- tests/test_realtime_contract.py
- tests/test_realtime_routes.py
- tests/test_realtime_manager.py
- tests/test_stream_manager.py
- tests/test_stream_transcribe.py
- tests/test_task_lifecycle.py
- tests/test_audio_budget.py
- tests/test_inline_audio_budget.py

这些测试文件说明相关模块具备回归测试入口；本说明不声称本轮已在当前工作区运行完整测试套件。

## 4. 当前 Git 与交付边界

- 已提交基线：main 分支 HEAD 117552146254，与 origin/main 同步（审计时 ahead/behind 为 0/0）。
- 该基线之前的版本提交已存在于 Git 远端。
- 历史部署记录中的 mediaflow:1.8.0 镜像，尚未与当前 1.8.7 源码提交建立构建产物映射，不能将两者视为同一版本。
- 当前工作区另有未提交变更，涉及历史任务索引替换、事件会话和 SQLite TaskStore 等文件。这些变更没有包含在本说明所述的 1.8.7 基线中；在完成代码审查和测试之前，不作为已交付成果，也不应随本次技术说明一起提交。

## 5. 建议补齐的产品证据

1. 将目标部署镜像 tag、digest、构建时间与源码 Commit 对应。
2. 对实时 WebSocket、流式转写、容量拒绝、长音频预算和历史记录查询执行部署版本回归。
3. 将现场性能数据与测试样本、硬件环境、并发配置一并归档；没有可复核原始记录时，不填写性能提升百分比。
