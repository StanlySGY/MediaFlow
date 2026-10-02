# 审查结果

## 结论

本轮完成了 MediaFlow 审查续项，重点闭环浏览器 SSE 鉴权凭证、退出登录清理、EventSource 建连时序和最终验证。当前没有在本地代码审查、测试和构建范围内发现已确认的 Critical 问题。

浏览器不再把长期访问令牌放入 EventSource URL。普通 Bearer 请求成功后签发短期 HttpOnly、SameSite=Strict 的 SSE cookie；cookie 只在 `/events` 或 `/stream` 路由被接受，普通 POST/PUT/DELETE 等状态变更不能仅凭该 cookie 通过鉴权。命令行 `?token=` 兼容路径仍保留，并在文档中明确其日志泄漏风险。

结论不等同于独立双模型验收通过：本轮两次外部 reviewer 调用仍因工具环境失败，没有产生可用报告。

## 已完成改进

- `require_token` 增加短期 `mediaflow_sse_auth` cookie，设置 `HttpOnly`、`SameSite=Strict`，仅允许 SSE endpoint 使用；普通鉴权成功响应刷新 cookie。
- 新增 `POST /auth/logout`，只删除浏览器 SSE cookie，不试图撤销客户端管理的 Bearer token。
- 前端 `sseUrl()` 删除 query token；`clearSession()` 同步清理 localStorage token 和服务端 SSE cookie。
- App 的令牌清除操作和自动 401 取消路径统一调用 `clearSession()`，避免 UI 已退出但 SSE cookie 仍有效。
- 监控页等待鉴权快照请求成功后再建立 EventSource，避免首次连接在 cookie 签发前抢跑。
- 文档、OpenAPI 描述和测试更新为 cookie 优先的浏览器流程，同时保留 CLI query token 兼容说明。
- 流式转写测试改用临时目录和 fake provider，避免依赖持久化运行时配置或真实外部 ASR 服务。

## Findings

### Critical

无已确认项。

### Warning

1. 访问令牌仍是共享 token 集合，任务和实时会话没有用户所有权或多租户隔离。当前模型适用于受信任的单用户/内网部署，不应直接作为多用户 SaaS 授权模型。
2. ASR 并发额度、实时会话表和 SSE 订阅状态都是进程内资源。多 worker 或多副本会分别计数，部署必须保持单 worker，或后续迁移到 Redis/数据库等共享协调层。
3. runtime config 原子替换没有跨进程文件锁。单进程写入安全，但并发配置更新仍可能出现最后写入覆盖；扩大部署前应增加锁和版本检查。
4. 服务关闭路径不会等待所有进行中的 ASR 任务完成。容器重启或发布可能留下未完成任务和未发送的 SSE 终态；后续应增加 shutdown drain、取消通知和可恢复任务状态。
5. `ruff check .` 仍报告已有的 `deploy/qwen3-asr-npu/asr_api.py` 中 3 项 E402/F401；该文件不属于本轮修改范围。应用、测试和部署配置相关 Python 代码的编译检查通过，未为清理无关文件扩大变更范围。

### Info

1. `realtime_offline` 在结束时合并音频后调用 ASR，不是原生低延迟识别；低延迟场景应使用 `realtime_http` 或 `realtime_ws`，并满足对应 provider 契约。
2. SSE query token 仍为 CLI 兼容接口，可能进入代理访问日志；浏览器集成应使用先发起 Bearer HTTP 请求、再使用同源 EventSource 的 cookie 流程。
3. 外部审查未形成独立报告：Antigravity 返回地区资格 `403 PERMISSION_DENIED`；Claude wrapper 以退出码 1 失败，错误为 `--gemini-model parameter is only effective with --backend gemini`。因此没有声称双模型批准。
4. 项目没有 `.ccg/spec` 目录，本轮没有可回馈的项目规范文件。

## 验证结果

通过：

- 后端完整测试：`timeout 180s env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u NO_PROXY -u no_proxy /tmp/mediaflow-verify.bdpvSh/venv/bin/python -m pytest -q`，`210 passed in 12.80s`。
- 后端重点安全、路由、生命周期和流式测试：`45 passed in 4.13s`。
- 前端完整测试：`npm test`，11 个测试文件、`50 passed`。
- 前端静态检查和生产构建：`npm run lint && npm run build` 通过，TypeScript 检查和 Vite 构建完成。
- Python 编译检查：`/tmp/mediaflow-verify.bdpvSh/venv/bin/python -m compileall -q app asr-deploy-code tests` 通过。
- `git diff --check` 通过。

补充：直接运行 `ruff check .` 被上述部署目录中的 3 项既有问题阻断；这不是本轮引入的回归。后续若要把仓库级 Ruff 变成硬门禁，应单独修复该部署文件或调整其 lint 范围。

## 归档状态

本任务完成后将移动到 `.ccg/tasks/archive/2026-10/`，归档提交只包含本任务记录，不包含工作树中的应用代码、用户已有修改或 `.env` 的 staged deletion。
