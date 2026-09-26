# MediaFlow 全面项目审查报告

审查日期：2026-09-26
审查范围：仓库内后端、前端、配置、部署文件、静态资源、测试与文档；忽略 `node_modules/`、工具缓存和生成目录。
审查方式：静态代码追踪、配置与部署检查、测试/构建/lint/静态检查。

## 一、结论总览

| 审查维度 | 结论 | 核心判断 |
| --- | --- | --- |
| 项目概览与组织 | 良好 | 产品边界、技术栈和模块划分清楚，但运行时状态主要在单进程内存中，部署边界应明确为可信内网单机。 |
| 后台 UI/UX | 一般 | 视觉 token 和主要工作流完整，然而导航状态、错误恢复、可访问性和离线部署体验仍有明显缺口。 |
| 功能逻辑 | 一般 | 文件转写、实时识别、历史、字幕和配置形成了主流程，但任务所有权、取消、实时会话清理和并发边界不完整。 |
| 完整度 | 一般 | 功能广度较高，测试基础较好；默认 mock、遗留流式入口、资源保留和生产运维闭环尚未完成。 |
| 代码质量与安全 | 一般（代码质量良好，安全较差） | provider/服务分层和测试值得肯定，但默认关闭鉴权、无资源所有权、SSRF 面和密钥管理问题阻碍生产使用。 |
| 性能与可扩展性 | 一般 | 单机小规模使用可行；任务级并发、无界实时缓存、永久 session 字典和单进程状态会限制并发扩展。 |

一句话总体评价：MediaFlow 是一个功能覆盖较完整、模块化和测试基础不错的音视频/ASR 内网工具，但当前的默认安全边界、数据隔离、资源生命周期和并发架构不足以支撑公网或多租户生产部署。

## 二、项目概览

### 2.1 项目定位与目标用户：良好

README 将项目定位为“音视频处理工具箱”，覆盖长音频切分、OpenAI 兼容 ASR 转写、实时识别、字幕导出和无损合并，见 `README.md:1-19`。从功能形态看，主要目标用户是需要批量处理音视频、校对转写结果、配置内网或云端 ASR 的内容运营、媒体处理和模型服务运维人员，而不是面向普通消费者的 SaaS 产品。

产品边界也在部署文档中有所体现：`README.md:82-86` 明确要求单 worker，说明任务、SSE 和实时会话依赖单进程内存。这一约束应在产品定位和部署校验中更醒目地标为“单机/可信内网工具”，否则使用者容易把它误解为可直接横向扩展的后台服务。

### 2.2 技术栈：良好

- 后端是 FastAPI、asyncio、Pydantic、httpx、SSE Starlette、websockets，依赖版本集中固定在 `requirements.txt:1-14`。
- 音视频处理以 FFmpeg 为核心，ASR 通过 provider 抽象接入 `openai_compat`、`openai_chat_audio` 和多种实时 provider，主要实现位于 `app/services/asr/`。
- 前端是 React 19、TypeScript、Vite、Tailwind CSS、Framer Motion 和 lucide-react，见 `frontend/package.json:1-41`。
- 没有关系数据库或独立任务队列；任务、配置和结果分别依赖内存字典、`config/runtime_config.json`、`temp/` 和 `outputs/`。这一点由 `app/config.py:70-76`、`app/services/realtime_manager.py:126` 和 `app/services/stream_manager.py:425-430` 共同体现。

### 2.3 目录与组织：良好

`app/api`、`app/models`、`app/services` 和 `app/services/asr` 的边界清楚，路由层没有把 FFmpeg、ASR 协议和字幕拼接全部揉在一起；前端按 `components`、`hooks`、`lib`、`types` 分组；`deploy/` 下还保留了 CUDA/NPU 离线部署材料。测试按路由、provider、任务生命周期、字幕、切分、合并和运行时配置拆分，结构符合当前单体工具的规模。

主要组织性风险不是目录问题，而是状态存储策略：多进程、重启恢复、跨实例 SSE 和用户隔离均没有独立持久化层。README 的单 worker 提示是限制说明，不是扩展方案。

## 三、后台 UI/UX 审查

### 3.1 视觉设计与组件一致性：一般

前端已经建立了较完整的设计 token：背景、表面、文字、边框、强调色、成功/警告/错误色集中在 `frontend/src/index.css:3-35`；表单、按钮、badge、toast、tab 和历史项也有统一基础样式，见 `frontend/src/index.css:73-169`。这使文件转写、实时识别、配置、监控和历史页面具有一致的控制台风格。

但存在两套颜色/字体配置并行维护：`frontend/tailwind.config.js:9-20` 仍定义深色 `bg/sidebar/panel` 和紫色 accent，而 `frontend/src/index.css:5-34` 使用浅色表面和蓝色 accent。即使当前构建结果主要由 CSS token 驱动，这种分叉会让新增组件容易出现颜色漂移，也增加主题切换和视觉回归成本。

`frontend/src/App.css:1-184` 仍保留明显的 Vite 脚手架 hero/next-steps 样式，而业务界面实际在 `index.css` 和组件 class 中实现。它不是当前功能 bug，但属于未清理的视觉技术债。

### 3.2 信息架构与操作效率：一般

侧边栏多 tab 覆盖文件任务、实时识别、配置、历史和监控，核心能力可发现性尚可；历史页已有搜索、状态过滤和分页逻辑，说明高频查询路径已被考虑。

主要问题是视图状态只存在 React 本地状态：`frontend/src/App.tsx:38-47` 使用 `currentView` 等 state，未见 URL 路由或 query/hash 同步。用户刷新、复制链接或浏览器后退无法回到当前功能页面，也无法分享配置/历史的上下文。建议至少用稳定的 URL search/hash 表示一级视图，复杂详情再引入轻量路由。

### 3.3 反馈、错误和恢复：一般

- “清空”只清理前端资源和状态：`frontend/src/App.tsx:318-321` 调用 `resetTask`，而 `frontend/src/hooks/useFileTask.ts:69-95` 没有调用后端 `POST /asr/task/{task_id}/cancel`。用户看到页面清空，不等于服务器停止 FFmpeg、ASR、重试和结果写入。
- 文件 SSE 出错后直接关闭：`frontend/src/hooks/useFileTask.ts:227-231` 没有重连、事件回放或最终结果补齐。后端本身有事件历史回放能力，见 `app/api/routes.py:829-836`，前端却没有利用它。
- SSE JSON 数据直接 `JSON.parse`，见 `frontend/src/hooks/useFileTask.ts:196-198`，异常 payload 会使消息处理函数抛错，缺少面向用户的错误状态。
- 剪贴板操作失败没有反馈，见 `frontend/src/hooks/useFileTask.ts:315-319`；在权限受限浏览器或 HTTP 非安全上下文中，用户无法知道复制失败的原因。

### 3.4 响应式与可访问性：一般

项目有移动端抽屉布局说明和若干响应式 class，但本次没有浏览器 E2E、移动端截图或视觉回归证据，因此不能确认长文本、配置表单、历史列表和实时日志在窄屏下没有横向溢出或遮挡。

可访问性存在两个可复核问题：

- `frontend/src/components/SegmentList.tsx:123-145` 用 `role="button"` 的外层 div 包含真正的播放 button，形成嵌套交互元素；键盘焦点、事件冒泡和屏幕阅读器语义容易冲突。应把展开行为改为真实 button，或把播放控制移出可点击区域。
- `frontend/src/components/HistoryView.tsx:191-196` 用仅绑定 `onClick` 的 `motion.div` 作为历史项，没有 `role`、`tabIndex` 和键盘触发路径；键盘用户无法等价加载历史任务。

`frontend/index.html:8-10` 从 Google Fonts 加载字体。离线现场部署可能退回系统字体，并且每次打开后台都会产生外部字体请求；这与项目强调的 air-gapped 部署场景不一致。应自托管字体或提供完全本地的字体栈。

## 四、功能逻辑审查

### 4.1 主业务闭环：一般

文件转写的主链路是：上传文件 -> FFmpeg 标准化/切分 -> 并发调用 ASR -> SSE 推送分片 -> 合并文本/字幕 -> `outputs/*.json` 持久化 -> 历史查询。对应实现分布在 `app/api/routes.py:580-650`、`app/services/stream_manager.py:500-675`、`app/services/subtitles.py` 和 `app/services/stream_manager.py:417-430`。能力闭环基本成立，且失败分片能够隔离并呈现错误。

实时链路是：创建 session -> 浏览器 `getUserMedia`/MediaRecorder -> base64 chunk -> provider -> SSE -> finish/delete。路由契约在 `app/api/routes.py:1272-1406`，前端入口在 `frontend/src/components/RealtimeRecorderPanel.tsx:210-242`。该链路的资源清理和并发边界不完整，见下方问题。

配置链路是：前端读取有效配置/profile -> POST runtime override -> 写 `config/runtime_config.json` -> 立即作用于 live Settings，见 `app/api/routes.py:930-1090` 和 `app/config.py:208-226`。它方便运维，但在未鉴权时等同于远程控制 ASR 出口、模型和访问令牌。

### 4.2 权限和数据所有权：较差

所有 `/asr` 和 `/media` 路由共享同一个 `require_token` 依赖，见 `app/api/routes.py:83-87`；`app/security.py:18-21` 在 `ACCESS_TOKENS` 为空时直接放行。即使配置了 token，任务和 session 也没有 owner、用户 ID、租户 ID 或角色字段：

- 文件任务状态、结果、字幕、SSE、取消、删除和原始分片响应均只按 `task_id` 访问，证据见 `app/api/routes.py:778-898`、`app/api/routes.py:1214-1266`。
- 实时 session 查询、上传、结束、删除只按 `session_id` 访问，见 `app/api/routes.py:1304-1406`。

因此共享 token 只能证明“请求带有同一个门票”，不能证明“请求者拥有这个任务”。只要 task/session ID 泄露，同一 token 下的其他使用者即可读取、删除或取消资源。

### 4.3 实时会话生命周期：一般

`RealtimeRecorderPanel` 在取得麦克风之前创建服务端 session，顺序见 `frontend/src/components/RealtimeRecorderPanel.tsx:216-235`。但 `cleanup()` 只关闭 SSE、停止 recorder 和媒体轨道，见 `frontend/src/components/RealtimeRecorderPanel.tsx:80-91`，没有调用后端 DELETE。用户拒绝麦克风、浏览器不支持 MediaRecorder 或初始化失败时，session 会留在服务端，直到默认 TTL 300 秒（`.env.example:68-70`）。

服务端容量检查也有竞态：`app/services/realtime_manager.py:173-192` 在取得 `_lock` 前统计 live session，`app/services/realtime_manager.py:199-201` 才加锁写入。多个并发创建请求可能同时通过上限检查，短时间超过 `realtime_max_sessions`。

`realtime_offline` 只限制单个 chunk：`app/services/realtime_manager.py:241-255`；offline provider 用无界 `bytearray` 累积所有音频，见 `app/services/asr/realtime_offline.py:47-52`、`83-98`，结束时才一次性落盘和调用 ASR（`app/services/asr/realtime_offline.py:100-115`）。恶意客户端或异常录音可持续消耗进程内存和磁盘。

### 4.4 任务取消、重试和并发：一般

- `_transcribe_all` 每个文件任务新建一个 semaphore，见 `app/services/stream_manager.py:580-584`。所以 `ASR_CONCURRENCY=4` 是“每个任务 4 路”，不是整个进程 4 路；多个长任务会同时放大上游请求、内存、网络和 CPU 压力。
- `stream_manager` 在 `app/services/stream_manager.py:592-630` 捕获所有 `ASRError` 后重试。provider 层虽然定义了 `RetryableASRError`，并对 5xx/429 与 4xx 区分（`app/services/asr/openai_compat.py:113-116`），但上层没有按异常类型区分，400、协议错误或参数错误仍可能被重复请求。
- 取消状态在结果 API 中处理不一致：`app/api/routes.py:839-848` 只把 `done`/`failed` 当终态，`cancelled` 会走 202 分支，客户端可能长期收到“仍处理中”的语义。

### 4.5 遗留流式入口：较差

旧的 `/transcribe-stream` 使用永久 `_sessions` 字典，见 `app/services/stream_transcribe_manager.py:25-33`。完成任务时 `finally` 只删除文件和工作目录，见 `app/services/stream_transcribe_manager.py:166-172`，没有删除 session；路由也只有创建和 SSE 读取，没有 session 删除/TTL 接口（`app/api/routes.py:1409-1462`）。重复调用该入口会造成长期内存增长。

## 五、完整度评估

### 5.1 已完成或基本完成的能力

- 多格式上传、FFmpeg 标准化、fixed/silence/overlap 切分。
- OpenAI 兼容 multipart/chat audio provider 及 realtime HTTP/WebSocket/offline/mock provider。
- 分片并发转写、SSE 事件、事件历史回放、失败分片隔离、字幕 SRT/VTT 导出。
- 前端文件任务、实时识别、历史搜索/过滤/分页、服务配置、监控、无损合并和结果下载。
- 结果 JSON 持久化和启动时失败任务恢复相关逻辑；对应测试覆盖了任务生命周期、provider、路由、字幕、切分和合并。

README 的功能清单和 API 文档较完整，`app/models/schemas.py:121-209` 对标准事件字段也有明确约束，这是项目的主要完整度优势。

### 5.2 疑似半成品、默认假数据和遗留物

- 默认 realtime provider 是 `realtime_mock`：`app/config.py:56`、`.env.example:60`。配置页面也明确标出“演示数据”，见 `frontend/src/components/ConfigView.tsx:20-25`；文档虽有说明，但用户首次打开实时识别仍可能得到看似成功的假转写。生产镜像应要求显式选择 provider，或在首屏强提示并禁用 mock 写入历史。
- `frontend/src/assets/react.svg`、`frontend/src/assets/vite.svg`、`frontend/src/assets/hero.png` 没有业务引用，属于脚手架/无效静态资源；`frontend/src/App.css` 也保留脚手架样式。
- 旧 `/transcribe-stream` 仍暴露，但没有完整生命周期闭环，见上节。
- 当前没有发现可作为完成标准的浏览器 E2E、移动端视觉回归、并发压测、SSRF/越权测试、数据保留测试或资源配额测试。

### 5.3 明显缺失的生产必要能力

最关键的缺失不是常规搜索/分页（历史页已有），而是：强制鉴权策略、角色/租户与资源 owner、审计日志、限流和总资源配额、数据自动过期/删除、上游探针健康检查、可恢复 SSE、跨实例任务存储，以及针对权限和 SSRF 的自动化测试。

## 六、代码质量与安全

### 6.1 代码质量：良好

provider 协议、registry、实时 provider 和任务 manager 的分层清晰；Pydantic schema 和错误模型使 API 契约可读；后端测试 174 项全部通过，前端 25 项全部通过，说明核心单元/接口行为有较好的回归基础。

但静态门禁不干净：

- `npm run lint` 在 `frontend/src/components/ConfigView.tsx:207` 失败，规则为 `react-hooks/set-state-in-effect`。
- `ruff check app asr-deploy-code` 发现 5 项错误：`app/services/asr/openai_chat_audio.py:163` 未使用的 `language`、`app/services/stream_transcribe_manager.py:6,14,19` 未使用 import、`asr-deploy-code/config.py:8` 未使用 `Field`。
- `mypy`、`bandit`、`pip-audit` 在当前环境不可用，因此没有完成类型、安全和依赖漏洞扫描。

### 6.2 P0 安全问题：默认关闭鉴权导致配置控制和 SSRF 面暴露

证据链如下：

1. `.env.example:45-48` 将 `ACCESS_TOKENS` 留空，并说明留空即关闭鉴权。
2. `app/security.py:18-21` 对空 token 列表直接 `return`。
3. `/asr/config` 可更新 provider、上游地址、模型、API key 和 access tokens，见 `app/api/routes.py:930-1009`。
4. `/asr/models` 接受任意 `base_url` 和 `api_key`，见 `app/api/routes.py:1065-1083`；`app/services/asr/models.py:34-62` 直接请求用户指定 URL，并将 key 放入 `Authorization`。

在端口暴露到非完全可信网络时，未登录请求者可以修改运行时 ASR 出口和访问令牌，也可以让服务端探测内网地址。若服务已有 ASR key，还存在把该 key 转发到攻击者指定端点的风险。应把鉴权从“可选且默认关闭”改为生产 fail-closed；配置/profile/模型探测应要求管理员权限，并对目标地址做严格 allowlist/egress 控制，不能只依赖字符串校验。

### 6.3 P1 数据隔离与敏感数据风险

- task/session 无 owner 的问题会造成跨用户读取、取消、删除和原始响应泄露，证据见 `app/api/routes.py:778-898`、`1214-1266`、`1304-1406`。
- 每个 `Segment` 可保留完整 `raw` 上游响应，见 `app/models/schemas.py:28-38`；终态结果将完整结果写入 `outputs/*.json`，见 `app/services/stream_manager.py:417-430`。没有按用户隔离、加密、自动过期、敏感字段脱敏或删除策略。
- 当前 `outputs` JSON 文件权限为 `0644`（例如 `outputs/0e5333f29a14495ca45b6c9f8825d7da.json`），同机其他用户可能读取转写内容或上游原始响应。
- `.env` 已被 Git 跟踪，且当前权限为 `0644`：`git ls-files --stage .env` 显示该文件在仓库中，`.gitignore:6` 只忽略 `.env.local`。当前字段为空不等于机制安全；未来误填 key/token 会进入版本库及历史。应立即将 `.env` 从版本控制中移除、轮换任何曾经写入过的密钥，并把忽略规则改为覆盖 `.env`（保留 `.env.example`）。
- `app/config.py:208-226` 先写 `.bak` 再直接 `path.write_text`，没有文件锁、临时文件和原子 rename。并发保存 profile/config 时可能互相覆盖或留下截断 JSON。

### 6.4 已检查到的正面安全点

`frontend/src/components/SegmentList.tsx:15-34` 在写入 `dangerouslySetInnerHTML` 前对 HTML 字符进行转义，本次没有确认可直接利用的 XSS sink。项目也没有 SQL 数据库，因此没有发现 SQL 注入路径；这不替代依赖扫描和动态安全测试。

## 七、性能与可扩展性

### 7.1 当前规模下可行：一般

单机、单 worker、有限并发的可信内网场景下，FFmpeg 临时目录、内存事件流和本地 JSON 结果可以降低部署复杂度；模型 provider 抽象也便于替换上游。

### 7.2 主要瓶颈和扩展风险

- 任务级 semaphore 导致全局 ASR 并发不可控，见 `app/services/stream_manager.py:580-584`。
- realtime offline 的 `bytearray` 无累计大小/时长上限，见 `app/services/asr/realtime_offline.py:47-52`、`83-98`。
- realtime manager、task manager 和旧 stream manager 使用进程内字典；旧 stream session 永不清理，见 `app/services/stream_transcribe_manager.py:30`、`166-172`。
- 结果文件和临时目录的保留策略不完整；容器只挂载 `temp`、`outputs`、`config`，见 `docker-compose.prod.yml:27-31`，但没有按时间/容量回收机制。
- `/health` 永远返回 OK，见 `app/main.py:236-238`；Compose 健康检查只请求该接口，见 `docker-compose.yml:25-29` 和 `docker-compose.prod.yml:32-35`。FFmpeg 不存在、上游 ASR 不可用或实时 provider 失效时，容器仍可能显示 healthy。
- 前端没有 SSE 断线恢复和事件游标，后端的历史回放无法发挥作用，长任务在网络抖动时会增加人工重试和状态不一致。

若未来需要多 worker 或多副本，应把任务状态、事件、锁、会话和结果索引迁移到 Redis/数据库/对象存储，并通过队列统一控制 FFmpeg/ASR 并发；不能只把 uvicorn worker 数量调大。

## 八、问题清单

### P0 严重

1. **生产默认鉴权关闭，配置接口可被未登录访问。** `.env.example:45-48`、`app/security.py:18-21`。
2. **配置/模型探测允许用户控制上游 URL，形成 SSRF 和 API key 转发面。** `app/api/routes.py:970-1009`、`1065-1083`、`app/services/asr/models.py:34-62`。

### P1 重要

1. **没有 task/session 所有权或租户隔离。** `app/api/routes.py:778-898`、`1214-1266`、`1304-1406`。
2. **前端清空任务不取消后端任务。** `frontend/src/App.tsx:318-321`、`frontend/src/hooks/useFileTask.ts:69-95`。
3. **麦克风初始化失败会遗留实时 session。** `frontend/src/components/RealtimeRecorderPanel.tsx:80-91`、`216-242`。
4. **实时容量检查在锁外，存在超额创建竞态。** `app/services/realtime_manager.py:173-201`。
5. **每个文件任务单独创建 ASR semaphore，全局并发会失控。** `app/services/stream_manager.py:580-584`。
6. **非临时 ASR 错误会被上层重复重试。** `app/services/stream_manager.py:592-630`。
7. **realtime offline 会话累计音频无总大小/时长上限。** `app/services/realtime_manager.py:241-259`、`app/services/asr/realtime_offline.py:47-52`、`83-115`。
8. **旧 `/transcribe-stream` 完成后不清理 session 字典。** `app/services/stream_transcribe_manager.py:25-33`、`166-172`。
9. **转写结果包含 raw 上游响应，没有保留、隔离和脱敏策略。** `app/models/schemas.py:28-38`、`app/services/stream_manager.py:417-430`。
10. **`.env` 已跟踪且权限为 0644，未来密钥可能泄露到 Git 历史。** `.gitignore:6`，Git index 中存在 `.env`。
11. **运行时配置写入非原子，配置并发更新可能损坏或丢失。** `app/config.py:208-226`。
12. **健康检查只验证 HTTP 进程，不验证实际依赖。** `app/main.py:236-238`、`docker-compose.prod.yml:32-35`。
13. **文件 SSE 断线直接关闭，不重连或回放。** `frontend/src/hooks/useFileTask.ts:162-231`。

### P2 建议

1. **前端 lint 门禁失败，Ruff 也有 5 项未清理错误。** `frontend/src/components/ConfigView.tsx:207`；`app/services/asr/openai_chat_audio.py:163` 等。
2. **tab 状态不进入 URL，刷新和分享不保留上下文。** `frontend/src/App.tsx:38-47`。
3. **token 存 localStorage，SSE token 放 query string，可能进入历史/代理/日志。** `frontend/src/hooks/useAuth.ts:3-49`。
4. **Segment 展开区域嵌套 button，历史项缺少键盘交互。** `frontend/src/components/SegmentList.tsx:123-145`、`frontend/src/components/HistoryView.tsx:191-196`。
5. **SSE JSON.parse、剪贴板失败没有 UI 兜底。** `frontend/src/hooks/useFileTask.ts:196-198`、`315-319`。
6. **依赖 Google Fonts 与离线部署目标冲突。** `frontend/index.html:8-10`。
7. **默认 realtime provider 是 mock，首次使用可能得到假数据。** `app/config.py:56`、`.env.example:60`、`frontend/src/components/ConfigView.tsx:20-25`。
8. **脚手架静态资源和旧样式残留。** `frontend/src/assets/react.svg`、`vite.svg`、`hero.png`、`frontend/src/App.css:1-184`。

## 九、具体可执行的改进方案

### 第一阶段：上线前必须完成

1. 将鉴权改为生产 fail-closed；应用启动时若运行在非开发模式且没有 token 直接拒绝启动。将配置/profile/模型探测拆成管理员权限，业务读取接口至少保留只读权限。
2. 增加 `principal_id`/租户字段并为每个 task/session 绑定 owner；所有查询、SSE、取消、删除、raw 响应和字幕下载统一执行授权检查。共享 token 只能作为认证，不再作为资源授权。
3. `/asr/models` 禁止任意 URL 探测，改为服务端配置的 allowlist；阻断 loopback、RFC1918、link-local、云 metadata 地址和重定向到私网的请求，最好把出站请求交给固定 egress 代理。严禁把已有 API key 转发到未经授权的地址。
4. 从 Git 移除 `.env`，检查 Git 历史并轮换曾出现的密钥；应用层对 output/runtime 文件使用 `0600`，对 raw 字段做脱敏或默认不持久化。
5. 为任务和实时 session 增加总字节数、音频时长、单用户并发、队列长度和磁盘配额；超限时明确返回可操作错误。

### 第二阶段：修复流程和可靠性

1. 前端 `resetTask` 在有 task ID 时先调用 cancel，取消/离开实时面板时在 `finally` 调用 DELETE；服务端 create 的容量计数、插入和 provider 初始化使用同一个锁或原子计数器。
2. 把全局 ASR semaphore 注入 `TaskManager`/应用状态，所有任务共享；只对 `RetryableASRError`、429、5xx、网络超时重试，对 4xx/协议错误立即失败。
3. 为 SSE 增加事件 ID、Last-Event-ID 或显式 seq 游标；前端断线指数退避重连，重连后回放并用最终 result 对账，避免丢分片。
4. 为旧 `/transcribe-stream` 增加完成/失败/TTL 清理和 DELETE 接口；或者在迁移期明确弃用并下线入口。
5. `_write_store` 使用临时文件 + `fsync` + 原子 `os.replace`，并增加跨请求锁；配置/profile 使用同一套 Pydantic 校验。
6. `/health` 保留轻量 liveness，另增受保护的 readiness 检查，至少验证 FFmpeg/ffprobe、配置目录、上游探针和 provider 初始化；Compose 使用 readiness。

### 第三阶段：产品和工程质量

1. 用 URL 路由表示一级 tab，修复真实 button/键盘语义，统一 `index.css` 与 `tailwind.config.js` 的 token，删除脚手架资源；字体改为自托管或本地 fallback。
2. 增加 Playwright 的桌面/移动端核心流程测试：上传、断线恢复、取消、麦克风拒绝、配置保存、历史加载、越权访问；增加截图回归。
3. 在 CI 中加入 `npm run lint`、`ruff check`、类型检查、bandit、pip-audit，并将失败设为门禁；增加并发、SSRF、资源配额、保留策略和权限矩阵测试。
4. 若目标变成多用户/多副本，将状态迁移到数据库/Redis/对象存储，使用任务队列控制 FFmpeg/ASR，增加审计日志、数据删除 API 和按租户的用量计费/限额。

## 十、验证记录与限制

- 后端：`pytest -q`，174 passed。
- 前端：`npm test -- --run`，8 个测试文件、25 tests passed。
- 前端构建：`npm run build` 成功，JS 约 423.92 kB（gzip 132.47 kB），CSS 约 44.12 kB（gzip 7.97 kB）。
- Compose：`docker compose config --quiet` 通过。
- 前端 lint：失败 1 项，`frontend/src/components/ConfigView.tsx:207`。
- Ruff：失败 5 项，详见代码质量小节。
- `mypy`、`bandit`、`pip-audit` 当前环境不可用，依赖漏洞和完整类型/安全扫描未完成。
- `git diff --check` 受工作区原有 `handoff.md` 尾空格影响；本审查未修改该用户文件。
- 本次未运行浏览器截图、真实麦克风、真实 ASR 上游、并发压测和动态 SSRF/越权测试，因此 UI 移动端表现、真实部署网络行为和动态安全结论仍需在隔离环境补测。
- 按项目 AGENTS 要求再次并行调用 Antigravity 与 Claude 双模型审查，但两者均未产出有效报告：Antigravity 的 headless 运行因缺少 `command` 权限被自动拒绝并以 exit 1 结束；Claude 启动后以 exit 1 结束且没有 agent report。此前尝试也得到相同结果。本文结论仅采用仓库证据和本地验证，不将外部模型失败视为审查结论。

外部调用记录：

- Antigravity：`codeagent-wrapper --lite --progress --backend antigravity`，无报告输出，headless command permission denied，exit 1。
- Claude：`codeagent-wrapper --lite --progress --backend claude`，无报告输出，启动阶段退出，exit 1。

## 十一、评分

总体评分：**6.3 / 10**。

功能广度、模块边界、API 契约和现有测试基础可以给到 7 分以上；UI 一致性和单机内网使用体验也达到可用水平。扣分主要来自生产安全默认值和资源授权（严重）、任务/实时生命周期与全局并发控制（重要）、数据保留和单进程扩展限制，以及 lint/安全扫描门禁未闭环。综合判断：适合继续作为可信内网的单机工具迭代，不建议在完成 P0/P1 前直接公网暴露或承诺多用户 SaaS 能力。
