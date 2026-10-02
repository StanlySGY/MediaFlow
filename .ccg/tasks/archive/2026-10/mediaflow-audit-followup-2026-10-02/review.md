# 审查结果

## 结论

本轮完成了 MediaFlow 的全栈功能、跨模块状态流转、部署边界、UI/UX 关键路径和 ASR 适用性审查，并落地了配置可靠性、实时会话资源控制、认证一致性、历史任务可访问性和前端回归覆盖等改进。当前没有在本地代码审查和已通过的测试范围内发现已确认的 Critical 问题。

结论受两个条件限制：一是部分路由测试无法在当前安装的依赖组合中完成；二是两个外部 reviewer 均未产生有效报告。因此本文件不把本轮结果表述为完整的独立双模型验收通过。

## 已完成改进

- 运行时配置使用原子写入、权限收紧、`.bak` 备份、损坏文件保留和有效备份恢复；Pydantic 校验后的规范化值才会应用到内存。
- 配置 reset 在写盘成功后才更新内存；本轮又修复了 profile 首次保存和 profile 激活的相同失败顺序问题，并增加写入失败回归测试。
- ASR 任务使用进程级共享并发限制；排队任务取消后不会再调用上游。
- 配置档案拆分文件和实时 provider、endpoint、model、API key，支持显式清除密钥；旧档案的实时字段惰性回填。
- 任务结果查询包含 cancelled 状态；历史任务的查看和删除操作改为可聚焦、可键盘操作的按钮。
- 并发 401 请求共享重认证提示，旧请求不会覆盖较新的 token。
- 实时会话增加并发、单 chunk、单会话字节数和时长限制，并在结束、异常和断开路径清理 provider 与会话状态。
- 默认绑定 loopback；multipart 请求体、模型探测和 `/metrics` 访问均增加边界控制或鉴权。
- 前端补充配置、历史、实时录音、认证和文件任务的回归测试，并完成窄屏关键流程的实现核对。
- 结合 Buzz、Whisper-WebUI、WhisperX 的文件/视频/YouTube、批处理/翻译、词级时间戳/说话人标签能力进行对照。本轮没有把 YouTube、翻译或说话人分离强行引入当前单服务架构。

## Findings

### Critical

无已确认项。该结论仅覆盖本地静态检查、已通过的单元/集成测试和人工代码审查范围。

### Warning

1. 实时 SSE token 仍通过 URL query 参数传递。代理访问日志、浏览器历史或链路追踪可能记录 token；后续应优先改为受支持的 header/cookie 鉴权，或设计一次性短期订阅凭证，并同步更新浏览器和第三方客户端契约。
2. 当前 token 是共享 token 集合，任务和实时会话没有用户所有权或多租户隔离。适用于受信任的单用户/内网部署，但不应直接当作多用户 SaaS 的授权模型。
3. ASR 并发额度、实时会话表和 SSE 状态都是进程内资源。多 worker 或多副本部署会分别计数，部署必须保持单 worker，或后续迁移到 Redis/数据库等共享协调层。
4. runtime config 的原子替换没有跨进程文件锁。单进程写入是安全的，但并发管理请求仍可能出现最后写入覆盖；需要多进程部署或高并发配置更新时，应增加锁和版本检查。
5. 服务关机路径不会等待所有进行中的 ASR 任务完成。容器重启或发布可能留下未完成任务和未交付的 SSE 终态；后续应增加 shutdown drain、取消通知和可恢复任务状态。
6. 路由层完整回归尚未在项目锁定依赖中执行。当前环境版本为 FastAPI 0.141.1、Starlette 1.6.0、AnyIO 4.14.2，而项目声明为 FastAPI 0.136.3、Starlette 1.1.0、AnyIO 4.13.0；当前 `TestClient.__enter__()` 会阻塞，部分 ASGITransport 的实时 POST 路由也超时。发布前应在锁定依赖环境重跑这些测试。

### Info

- `realtime_offline` 会在结束时合并音频后调用真实 ASR，不是原生低延迟实时识别；低延迟场景应使用 `realtime_http` 或 `realtime_ws`，并满足对应 provider 契约。
- 本轮保持单服务、单用户部署边界，没有引入 YouTube 下载、翻译、词级对齐或说话人分离；这些是明确的后续产品能力，不是当前修复遗漏。
- 外部审查未形成独立报告：Antigravity 返回地区资格 `403 PERMISSION_DENIED`；Claude wrapper 以退出码 1 失败，错误为 `--gemini-model parameter is only effective with --backend gemini`。当前工具环境也没有可用的 `ccg-review` agent 类型。

## 验证结果

通过：

- `frontend`: `npm test -- --run`，11 个测试文件、48 项测试通过。
- `frontend`: `npm run lint` 通过。
- `frontend`: `npm run build` 通过，TypeScript 检查和 Vite 生产构建完成。
- 后端重点测试集通过，合计 162 项；其中 runtime config 测试 32 项。
- `python -m pytest -q tests/test_ffmpeg_service.py`：3 项通过。
- `ruff check app tests` 通过。
- `python -m compileall -q app tests` 通过。
- `git diff --check` 通过。

未能在当前环境完成：

- `tests/test_realtime_routes.py`
- `tests/test_routes.py`
- `tests/test_security.py`
- `tests/test_stream_transcribe.py`
- `tests/test_task_lifecycle.py`

这些测试的阻塞原因是上面记录的 FastAPI/Starlette/TestClient 依赖不匹配，不是将挂起误记为通过。`test_ffmpeg_service.py` 单独运行通过；与其他 subprocess/asyncio 测试组合时，当前 Python 3.13 环境仍存在跨 event-loop/process transport hang 风险。

## 后续建议

优先级顺序建议为：先在锁定依赖环境恢复路由测试；随后替换 SSE query token 并补充订阅凭证测试；如果部署范围扩大到多 worker/多租户，再引入共享状态、配置锁、任务所有权和 shutdown drain。当前单 worker、受信任网络的部署边界应在 README 和运维配置中继续保持明确。
