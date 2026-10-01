# MediaFlow 产品与技术审查

## 结论

本轮没有确认 P0。三项首轮代码审查 Warning 已修复并加入回归测试；本次安全收尾也已关闭默认网络暴露、任意模型探测 URL、multipart 解析前无请求体上限及 `/metrics` 未复用令牌校验等问题。外部双模型复核受环境限制未能返回结果，详见末节。

## 已交付

- 文件任务 ID 持久化；刷新时恢复任务、重连可回放 SSE，并从结果 API 补齐终态数据。断线后由轮询继续兜底；历史页查看活动任务不会取消原后台任务。
- 实时麦克风和高级模拟器提供文稿复制/TXT 下载与反馈。SSE 断线时保留采集会话，重连重置文本基线，避免重复拼接。
- 文件与实时配置档案独立保存 provider、endpoint、模型和密钥；旧档案惰性回填，API 不回显密钥。
- 模型探测区分目标管线；显式密钥只存在 POST body，不再进入浏览器请求 URL。共享 endpoint 使用各自管线密钥。
- 流式转录 shutdown 先停止 worker supervisor，再回收任务；停止期间不接受新会话。
- 390px 和 320px 配置页检查通过，操作栏保持单行且无水平溢出；桌面首页布局可见，浏览器控制台无错误。

## 安全收尾（2026-10-02）

- 本地 Settings 与 `.env.example` 默认绑定 `127.0.0.1`；普通 Compose 宿主端口只发布到 `127.0.0.1`，容器内部仍绑定 bridge 所需的 `0.0.0.0`。host-network 部署继承 loopback 默认值；README 提醒既有 `.env` 不会自动迁移，并说明远程开放前先设令牌。
- `/asr/models` 仅探测当前配置或已保存档案里的 endpoint；未保存的地址在发起网络请求前返回 400。已保存的内网/自托管 endpoint 仍可探测；一次性密钥仍只通过 POST body 传入。
- ASGI 接收层同时检查 `Content-Length` 和实际分块字节数，将 multipart 总请求体限制在 `MAX_UPLOAD_BYTES + 64 KiB`，在 Starlette 文件暂存前拒绝超限；原有文件级大小检查保留。
- `/metrics` 使用与 API 相同的 `require_token` 依赖。未配置令牌时依旧遵循单机 loopback 模式；手工开放网络的操作步骤要求先设置令牌。
- 新增未配置公网/私网地址拒绝、已保存内网 endpoint 允许、multipart 声明长度与分块长度拒绝、指标鉴权及 loopback 默认测试。

## 残余风险

- **P2 - 远程开放仍需部署者按文档操作。** 应用无法从容器内部判断 bridge 端口是否被宿主机改成公网发布；手工开放端口却遗漏 `ACCESS_TOKENS` 仍会关闭鉴权。默认 Compose 与 host-network 已收回到 loopback，部署文档要求远程开放前设置令牌；既有 `.env` 也需人工检查。
- **P2 - ASR 并发限制按任务而非全局生效。** semaphore 在每个 `_transcribe_all` 内新建（`app/services/stream_manager.py:639-649`），多个并行任务会分别获得完整并发额度。建议增加共享 provider semaphore，并区分用户/服务级队列。
- **P2 - 任务与历史没有用户所有权模型。** 当前令牌校验只识别共享 token 集合（`app/security.py:8-32`），任务状态、结果及历史路由都直接访问单个全局 `TaskManager`（`app/api/routes.py:779-861,1247-1277`）。适用于可信单用户部署，不适用于多租户共享。
- **P2 - SSE 令牌通过 query string 支持。** 浏览器 `EventSource` 不能附加授权头，代理访问日志可能记录 `?token=`；部署代理应避免记录该参数，后续可考虑短期 SSE 凭证。
- **P2 - 运行配置不是原子写入。** 写入前保留 `.bak`，但随后直接覆盖 JSON（`app/config.py:214-232`）；进程中断可留下无效配置，当前加载器只忽略坏文件，不自动恢复备份。建议临时文件、fsync、原子替换并验证恢复。
- **P2 - 两处可用性缺口。** 档案编辑器把空密钥解释成“不修改”，因此 UI 无法明确清除已保存密钥（`frontend/src/components/ConfigView.tsx:339-350`、`app/services/asr/profiles.py:298-321`）；历史任务卡片是只有 `onClick` 的 `motion.div`，没有键盘语义（`frontend/src/components/HistoryView.tsx:191-196`）。

## 开源对照

- [Buzz README](https://raw.githubusercontent.com/chidiwilliams/buzz/main/README.md)：录音、转录查看和 TXT/SRT/VTT 导出是适合 MediaFlow 的可发现工作流；本轮补齐实时完整文稿复制和 TXT 下载。
- [WhisperX README](https://raw.githubusercontent.com/m-bain/whisperX/main/README.md)：词级对齐和说话人分离可作为后续字幕能力方向；本轮保留现有分段/时间戳管线，未引入新依赖。
- [Whisper-WebUI README](https://raw.githubusercontent.com/jhj0517/Whisper-WebUI/master/README.md)：浏览器批量转录和 Faster-Whisper 的本地部署模式适合参考；MediaFlow 的 provider/profile 分离保持了类似可替换性。

## 验证

- `pytest -q`：196 passed。
- `npm test`：37 passed，9 个测试文件。
- `npm run lint`：通过。
- `npm run build -- --outDir <临时目录>`：TypeScript 检查和生产构建通过，未改写 `app/web`。
- `ruff check app tests`、`git diff --check`：通过。
- 三份 Compose 文件均以 `.env.example` 显式作为插值环境并使用 `--no-env-resolution` 校验通过；普通 Compose 渲染结果确认 `host_ip: 127.0.0.1`、目标端口 8080。
- Playwright：桌面首页、390px/320px 配置页；无水平溢出，控制台无错误。未执行真实浏览器麦克风端到端；实时断线/回放由组件测试和后端测试覆盖。

## 独立审查限制

第一轮内部 reviewer 未发现 Critical，指出的三项 Warning 均已修复并验证。本次安全收尾并行调用 Antigravity 与 Claude：Antigravity 因地区资格限制返回 403，Claude wrapper 退出码 1，均未产生审查报告。因此本轮没有可用的双外部模型代码审查结论；不能把它们计为通过。
