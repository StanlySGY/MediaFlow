# MediaFlow 产品与技术审查

## 结论

本轮没有确认 P0。三项代码审查 Warning 已修复并加入回归测试：文件任务启动恢复短暂失败重试、模型探测按 file/realtime 命名空间选密钥且通过 JSON POST 传递一次性密钥、流式转录关闭时先停 supervisor 并拒绝新会话。浏览器检查另修复了窄屏配置页底部操作栏折行/挤压。

## 已交付

- 文件任务 ID 持久化；刷新时恢复任务、重连可回放 SSE，并从结果 API 补齐终态数据。断线后由轮询继续兜底；历史页查看活动任务不会取消原后台任务。
- 实时麦克风和高级模拟器提供文稿复制/TXT 下载与反馈。SSE 断线时保留采集会话，重连重置文本基线，避免重复拼接。
- 文件与实时配置档案独立保存 provider、endpoint、模型和密钥；旧档案惰性回填，API 不回显密钥。
- 模型探测区分目标管线；显式密钥只存在 POST body，不再进入浏览器请求 URL。共享 endpoint 使用各自管线密钥。
- 流式转录 shutdown 先停止 worker supervisor，再回收任务；停止期间不接受新会话。
- 390px 和 320px 配置页检查通过，操作栏保持单行且无水平溢出；桌面首页布局可见，浏览器控制台无错误。

## 残余风险

- **P1 - 默认无鉴权的全接口服务。** `ACCESS_TOKENS` 默认为空（`app/config.py:73`），校验器会在空配置时放行（`app/security.py:18-21`）；默认监听 `0.0.0.0`（`app/config.py:81`），Compose 发布 `8080:8080`（`docker-compose.yml:11-13`）。暴露到不可信网络时，调用者可提交转写、读取任务/历史并修改运行配置。后续应默认限制到 loopback，或在非本机部署强制令牌并提供显式 opt-in。
- **P1 - 模型探测存在 SSRF 面。** `/asr/models` 接受调用者提供的 `base_url` 并请求该地址的 `/models`、`/info`（`app/api/routes.py:1112-1129`；`app/services/asr/models.py:34-60`）。鉴权仍默认关闭，且没有网络出口限制；可访问私有网络或云元数据。后续应在部署层阻止 link-local/metadata 出口，并设计允许自托管 ASR 的显式私网策略。
- **P2 - 上传大小上限在 multipart 解析后执行。** 文件端点收到 `UploadFile` 后才按 `max_upload_bytes` 复制并拒绝超限（`app/api/routes.py:590-620`）；Starlette 解析/暂存请求体发生在端点之前，大请求仍可能先占用临时盘。建议在反向代理或 ASGI 接收层按流量限额。
- **P2 - ASR 并发限制按任务而非全局生效。** semaphore 在每个 `_transcribe_all` 内新建（`app/services/stream_manager.py:639-649`），多个并行任务会分别获得完整并发额度。建议增加共享 provider semaphore，并区分用户/服务级队列。
- **P2 - 任务与历史没有用户所有权模型。** 当前令牌校验只识别共享 token 集合（`app/security.py:8-32`），任务状态、结果及历史路由都直接访问单个全局 `TaskManager`（`app/api/routes.py:779-861,1247-1277`）。适用于可信单用户部署，不适用于多租户共享。
- **P2 - 监控端点未套用鉴权。** `/metrics` 位于无全局依赖的 `meta_router`（`app/api/routes.py:84-88,902-923`），会暴露调用量和活跃任务计数。另，SSE 令牌通过 query string 支持（`app/security.py:14-16,28-29`），代理访问日志可能记录令牌。
- **P2 - 运行配置不是原子写入。** 写入前保留 `.bak`，但随后直接覆盖 JSON（`app/config.py:214-232`）；进程中断可留下无效配置，当前加载器只忽略坏文件，不自动恢复备份。建议临时文件、fsync、原子替换并验证恢复。
- **P2 - 两处可用性缺口。** 档案编辑器把空密钥解释成“不修改”，因此 UI 无法明确清除已保存密钥（`frontend/src/components/ConfigView.tsx:339-350`、`app/services/asr/profiles.py:298-321`）；历史任务卡片是只有 `onClick` 的 `motion.div`，没有键盘语义（`frontend/src/components/HistoryView.tsx:191-196`）。

## 开源对照

- [Buzz README](https://raw.githubusercontent.com/chidiwilliams/buzz/main/README.md)：录音、转录查看和 TXT/SRT/VTT 导出是适合 MediaFlow 的可发现工作流；本轮补齐实时完整文稿复制和 TXT 下载。
- [WhisperX README](https://raw.githubusercontent.com/m-bain/whisperX/main/README.md)：词级对齐和说话人分离可作为后续字幕能力方向；本轮保留现有分段/时间戳管线，未引入新依赖。
- [Whisper-WebUI README](https://raw.githubusercontent.com/jhj0517/Whisper-WebUI/master/README.md)：浏览器批量转录和 Faster-Whisper 的本地部署模式适合参考；MediaFlow 的 provider/profile 分离保持了类似可替换性。

## 验证

- `pytest -q`：190 passed。
- `npm test`：37 passed，9 个测试文件。
- `npm run lint`：通过。
- `npm run build -- --outDir <临时目录>`：TypeScript 检查和生产构建通过，未改写 `app/web`。
- `ruff check app tests`、`docker compose config --quiet`、`git diff --check`：通过。
- Playwright：桌面首页、390px/320px 配置页；无水平溢出，控制台无错误。未执行真实浏览器麦克风端到端；实时断线/回放由组件测试和后端测试覆盖。

## 独立审查限制

第一轮内部 reviewer 未发现 Critical，指出的三项 Warning 均已修复并验证。最终复核代理在多次催收后未返回结果，已关闭。Antigravity 返回地区资格 403；Claude wrapper 退出码 1，未产生审查报告。因此本轮没有可用的双外部模型代码审查结论；不能把它们计为通过。
