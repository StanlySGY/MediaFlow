# MediaFlow 内网单机定位校准审查报告

审查日期：2026-09-26
审查对象：MediaFlow 当前仓库实现与上一版综合审查报告
校准定位：可信内网、单用户、单机、长期运行的音视频/ASR 工具
校准目的：重新判断问题是否属于当前产品威胁模型和使用场景，而不是以公网、多租户或水平扩展产品为默认标准。

## 一、校准结论

| 维度 | 原评级 | 校准评级 | 结论 |
| --- | --- | --- | --- |
| 项目概览与组织 | 良好 | 良好 | 定位明确，目录边界清楚，多套 Docker/离线/模型部署方案与内网交付匹配。 |
| 后台 UI/UX | 一般 | 良好 | 六个工作区、组件样式、加载/空态和移动端抽屉基础完整；剩余主要是链接状态、断线恢复和可访问性打磨。 |
| 功能逻辑 | 一般 | 良好 | 文件转写、实时识别、历史、字幕、监控和合并形成可用闭环；缺陷集中在异常后的资源清理和并发配额，而不是单次转写正确性。 |
| 完整度 | 一般 | 良好 | 功能广度和测试覆盖对单机工具已经较完整；默认 mock 需要更强的用户提示，长期保留策略仍需补齐。 |
| 代码质量与安全 | 一般偏下 | 良好 | 模块化、provider 抽象和测试基础较好；公网安全项在当前威胁模型下不构成主要扣分，`.env` 卫生和静态门禁仍是实质问题。 |
| 性能与可扩展性 | 一般 | 良好 | 单进程内存态是当前部署目标的合理简化；评价重点应转为长期运行的内存、磁盘、会话和并发配额。 |

一句话总体评价：作为可信内网单机工具，MediaFlow 已具备日常使用的产品完整度和工程基础，当前最值得投入的不是引入认证、Redis 或复杂出站防护，而是补齐任务/会话清理、资源上限、离线字体和工程门禁，让它能稳定长期运行。

总体评分：**7.6 / 10**。

## 二、评估标准的变化

### 2.1 当前场景不作为硬门槛的要求

以下问题在上一版按公网/多用户服务标准被高估，当前只保留为未来扩展提醒：

| 原问题 | 当前判定 | 依据 |
| --- | --- | --- |
| `ACCESS_TOKENS` 默认为空、请求可直接进入 | P2 建议 | `app/security.py:18-21` 明确把空 token 视为关闭鉴权；单用户可信内网工具采用无认证默认值可以成立，部署文档也已经说明配置方式。 |
| `/asr/models` 可探测指定上游地址 | P2 建议 | `app/api/routes.py:1065-1083` 和 `app/services/asr/models.py:34-62` 的调用对象是操作者自己配置的上游；当前网络边界中不把操作者对自有内网的探测视作越权攻击。 |
| API key 会随探测请求发往指定 URL | P2 建议 | key 和 URL 均由单用户本人配置，当前没有第三方租户或平台代管密钥的威胁模型；仍应在未来对外暴露时增加 allowlist。 |
| task/session 没有 owner、租户和角色 | 不适用 | `app/api/routes.py:778-898`、`1214-1266`、`1304-1406` 按 ID 查询在单用户场景不构成跨用户越权。若将来共享服务，必须重新升级。 |
| 单进程内存态、不能安全增加 worker | 合理架构选择 | `README.md:82-86` 已明确任务、SSE 和实时会话依赖单进程；当前目标就是单机部署，引入 Redis/队列不是当前必要条件。 |

这不是说上述实现具备公网安全性，而是说它们不应继续主导当前产品的评分。部署边界必须继续写在文档和运维交接中，不能把“内网单用户”误解成任意网络均可信。

### 2.2 当前场景仍然重要的标准

可信内网不能豁免工具对自身资源的保护。单用户快速连点、浏览器权限拒绝、网络断线、长时间录音、忘记删除历史和静态检查失败，都可能让操作者自己无法继续工作。因此本次把以下方面提高权重：

- 失败流程是否释放实时 session、媒体流和服务端 provider。
- “清空”是否真正停止后台任务，是否有输出/临时文件保留策略。
- 会话容量检查是否在并发请求下仍然成立。
- 长时间运行时内存、磁盘、累计音频和旧 session 是否有边界。
- air-gapped/无外网环境的首屏体验和默认行为是否可理解。
- 仓库是否会把未来填入的密钥带入 Git，以及 CI 是否真正阻止静态门禁回归。

## 三、项目概览与组织：良好

### 3.1 定位和目标用户

`README.md:1-19` 把项目定义为音视频处理工具箱，涵盖长音频切分、流式 ASR、实时识别、字幕导出、音视频无损合并和 Web UI。目标用户是需要在本地或内网处理媒体、校对文本、连接自部署 ASR 的内容运营、媒体处理和模型服务运维人员。

`README.md:58-86` 进一步覆盖了 air-gapped 交付、预加载镜像、宿主网络和单 worker 约束。这些内容与可信内网单机定位高度一致，说明部署边界不是偶然限制，而是产品设计的一部分。

### 3.2 技术栈和组织

后端使用 FastAPI/asyncio/Pydantic/httpx/SSE/WebSocket/FFmpeg，依赖版本固定在 `requirements.txt:1-14`；前端使用 React/TypeScript/Vite/Tailwind/Framer Motion/lucide-react，见 `frontend/package.json:1-41`。`app/api`、`app/models`、`app/services`、`app/services/asr` 的职责边界清楚，前端按 components/hooks/lib/types 分组，测试按 provider、路由、任务生命周期和媒体处理拆分。

不把没有数据库或 Redis 视为当前架构缺陷。任务和会话在内存中、结果在本地 JSON、配置在本地文件，是单机工具降低部署成本的合理取舍；需要补的是清理与配额，而不是盲目引入分布式基础设施。

## 四、后台 UI/UX：良好

### 4.1 信息架构和操作路径

侧边栏将功能分为工作台和管理区，六个主要入口清晰可见：文件转写、实时识别、历史记录、音视频合并、服务配置、调用监控，证据见 `frontend/src/components/Sidebar.tsx:20-29`。导航按钮使用真实 `button`，具有统一 active/hover 状态，见 `frontend/src/components/Sidebar.tsx:31-47`。

文件转写从上传、进度、分片详情、完整文本、字幕下载到历史加载形成连续路径；历史页面有加载态、空态、错误态，见 `frontend/src/components/HistoryView.tsx:170-185`。配置页将 provider、模型、热词、切分参数和实时 provider 集中管理，降低了内网运维的切换成本。

### 4.2 视觉与组件一致性

`frontend/src/index.css:3-35` 定义了背景、表面、文字、边框、强调色和语义色；表单、按钮、badge、toast、tab 和历史项也有统一样式，见 `frontend/src/index.css:73-169`。从控制台使用场景看，信息密度、颜色层级和控件重复使用达到良好水平。

仍有一个维护性问题：`frontend/tailwind.config.js:9-20` 保留一套深色/紫色 token，而 `frontend/src/index.css:5-34` 使用浅色/蓝色 token；`frontend/src/App.css:1-184` 还残留 Vite 脚手架样式。它们没有破坏当前主流程，但会增加后续组件样式漂移的概率，列为 P2。

### 4.3 响应式、反馈和可访问性

`frontend/src/components/Sidebar.tsx:51-54` 提供移动端固定抽屉与桌面 sticky 导航，按钮和加载/空态基础齐全，因此评级从“一般”上调为“良好”。但本次没有 Playwright 截图或真实移动浏览器验证，不能把响应式结论提高到优秀。

仍需打磨的证据：

- 一级 tab 保存在 React state，见 `frontend/src/App.tsx:37-47`，刷新或复制链接不能保留当前工作区。
- 文件 SSE 出错后直接关闭，见 `frontend/src/hooks/useFileTask.ts:162-231`，没有重连和历史事件补齐。
- `SegmentList` 的 `role="button"` 容器内嵌真实播放 button，见 `frontend/src/components/SegmentList.tsx:123-145`，语义和键盘焦点可能冲突。
- 历史项是只绑定 `onClick` 的 `motion.div`，见 `frontend/src/components/HistoryView.tsx:191-196`，键盘用户没有同等触发方式。

这些是体验打磨问题，不改变“核心工作流可用”的判断。

## 五、功能逻辑：良好

### 5.1 核心闭环已经成立

文件任务通过上传、切分、ASR、合并、SSE、结果持久化和历史查询完成闭环。任务管理器会在内存 TTL 和数量超限时清理已完成任务，见 `app/services/stream_manager.py:438-462`；结果可以从 `outputs` 重新加载，见 `app/services/stream_manager.py:464-475`。这说明历史功能不是纯前端 mock，单机重启恢复也有明确设计。

实时链路从 session 创建、MediaRecorder、音频 chunk、SSE 到 end/delete 都有对应 API 和前端操作，路由见 `app/api/routes.py:1272-1406`，前端录音见 `frontend/src/components/RealtimeRecorderPanel.tsx:216-289`。主流程能够完成一次真实操作，问题集中在失败清理和容量边界。

### 5.2 仍需修复的资源生命周期

1. 前端在创建服务端实时 session 后才调用麦克风权限，顺序见 `frontend/src/components/RealtimeRecorderPanel.tsx:216-237`；失败时 `cleanup()` 只关闭 SSE、停止浏览器流，见 `frontend/src/components/RealtimeRecorderPanel.tsx:80-91`，没有调用已经存在的 DELETE 端点 `app/api/routes.py:1394-1406`。当前实时上限是 **4**，不是 8，配置见 `app/config.py:60-68`；残留 session 会占用 live 配额，直到 TTL 或下一次创建触发过期回收。
2. 文件任务的“清空”按钮只调用前端 `resetTask`，见 `frontend/src/App.tsx:318-321` 和 `frontend/src/hooks/useFileTask.ts:69-95`，没有调用后端取消接口。后台任务可能继续 FFmpeg、ASR、重试并写入结果。虽然任务管理器有内存 TTL/数量回收，但已写入 `outputs` 的终态结果不会因此自动删除；长期无人管理时磁盘会持续累积。
3. `RealtimeManager.create()` 在锁外统计 live session，`app/services/realtime_manager.py:173-192`，到 `app/services/realtime_manager.py:199-201` 才锁内插入。单用户快速重复请求或浏览器重试可能同时通过容量检查，超过上限。
4. offline realtime provider 用无界 `bytearray` 累计音频，见 `app/services/asr/realtime_offline.py:47-52`、`83-98`；服务端只限制单个 chunk，见 `app/services/realtime_manager.py:241-259`。普通用户的超长录音即可造成自身进程内存和临时磁盘压力，应补累计字节数和时长上限。

这些问题不会让一次正常录音或一次正常转写必然失败，但会决定工具挂着运行几天后是否仍然可用，因此在当前定位下属于首要修复对象。

## 六、完整度：良好

已完成能力包括多格式上传、FFmpeg 标准化、三种切分、多个 ASR provider、实时 provider、分片并发、SSE、字幕导出、历史搜索/分页、配置、监控、无损合并和离线部署，功能清单见 `README.md:3-19`。

后端测试已覆盖路由、任务生命周期、provider、实时协议、字幕、切分、合并和运行时配置；前端测试覆盖 App、实时视图、监控视图、鉴权、字幕、下载和错误处理。对一个单机工具而言，这已经不是半成品基础。

### 6.1 默认 mock 的重新判断：P1（弱）

`app/config.py:56` 和 `.env.example:60` 将 `realtime_mock` 作为默认 provider，`frontend/src/components/ConfigView.tsx:20-25` 也显示“演示数据（不调用真实服务）”。它对离线演示、无上游环境和开发验收是合理默认，不能按“假数据导致功能未完成”处理；但用户进入实时识别页时如果没有同时看到当前 provider，可能把固定 mock 文本误判成真实识别质量问题。

建议在实时页面首屏显示明显的“演示模式/不调用真实 ASR”状态，并把当前 provider 放进顶部状态，而不是取消 mock provider。故列为 P1 弱项：影响首次体验和问题诊断，不影响离线流程跑通。

### 6.2 离线字体依赖：P1（有条件）

`frontend/index.html:8-10` 依赖 Google Fonts。完全 air-gapped 环境中请求会失败或等待超时后回退系统字体；这通常不应阻塞 React 应用逻辑，但会影响首屏字体稳定呈现、视觉一致性和离线交付的自洽性。若现场确有外网或已缓存字体，则降为 P2；若产品承诺无外网部署，应按 P1 处理并自托管字体或采用本地字体栈。

## 七、代码质量与安全：良好

### 7.1 代码质量和工程基础

provider/registry、实时管理器、任务管理器、FFmpeg、切分、合并和字幕模块边界清楚；Pydantic schema 对事件和请求字段有约束；结果持久化和失败恢复逻辑可读。当前验证结果是后端 `pytest -q` 174 passed，前端 8 个测试文件共 25 tests passed，前端构建成功，Compose 配置解析成功。

工程门禁尚未完全干净：

- `npm run lint` 在 `frontend/src/components/ConfigView.tsx:207` 触发 `react-hooks/set-state-in-effect`。
- `ruff check app asr-deploy-code` 发现 5 项未使用变量/import，涉及 `app/services/asr/openai_chat_audio.py:163`、`app/services/stream_transcribe_manager.py:6,14,19` 和 `asr-deploy-code/config.py:8`。
- CI ` .github/workflows/ci.yml:54-60` 只执行前端 build/test，没有 lint；当前环境也没有 `mypy`、`bandit`、`pip-audit`。

这属于工程质量扣分，不需要把项目降为“安全较差”。

### 7.2 `.env` 是当前真正的安全/仓库卫生问题：P1

`.env` 已被 Git 跟踪，`git ls-files --stage .env` 可见；文件当前权限为 `0644`，而 `.gitignore:6` 只忽略 `.env.local`。当前字段为空，所以没有证据表明现有仓库已经泄露真实 key；但只要运维按 README 填入 key 后执行常规提交，凭据就可能进入内网 GitLab 或交付仓库历史。

这是与公网无关的发布卫生问题，应把 `.env` 加入忽略、从 index 移除，并检查历史后轮换曾经写入过的真实密钥。运行时配置文件已有 `0600` 意图，但 `.env` 没有同等保护。

### 7.3 当前定位下的安全降级项

上一版 P0/P1 中的认证默认关闭、SSRF、API key 转发、task/session owner 和多 worker 状态，在本次评分中不再作为当前产品的严重缺陷：

- `ACCESS_TOKENS` 空时放行见 `app/security.py:18-21`，单用户可信内网可以接受。
- `/asr/models` 和 `/asr/config` 允许操作者指定目标见 `app/api/routes.py:930-1009`、`1065-1083`，当前是本人连接本人管辖的上游。
- task/session 按 ID 访问见 `app/api/routes.py:778-898`、`1304-1406`，当前没有其他用户对象需要隔离。
- 单进程约束见 `README.md:82-86`，与当前单机架构匹配。

它们统一降为 **P2/未来扩展前置项**：一旦端口开放到不可信网络、开始共享 token、接入多用户或代管第三方 key，就必须重新升级为上线阻断项。

## 八、性能与长期运行：良好

### 8.1 与单机定位匹配的设计

单进程任务状态、内存 SSE fan-out、本地结果 JSON、FFmpeg 并发配置和 ASR provider 抽象都能减少现场依赖；`app/services/stream_manager.py:438-462` 对内存任务做 TTL/数量回收，说明实现并非完全无边界。

不把“不能多 worker”或“没有 Redis”扣分。对于一台由单用户操作的内网机器，这些是可解释的部署选择。

### 8.2 仍然存在的长期运行风险

- 每个文件任务在 `app/services/stream_manager.py:580-584` 新建 ASR semaphore，多个任务叠加后总请求数超过单个 `asr_concurrency`；当前列为 P2，因为它影响吞吐和机器负载，但不是架构失配。
- 旧 `/transcribe-stream` 使用永久 `_sessions` 字典，见 `app/services/stream_transcribe_manager.py:25-33`；完成后只删除文件和工作目录，见 `app/services/stream_transcribe_manager.py:166-172`，列为 P2。它是遗留入口的缓慢内存增长问题，不影响新文件任务主链路。
- 输出文件按历史功能长期保留，且没有自动磁盘容量/时间清理策略。结合“清空不取消”问题，应在 P1 阶段补一个明确的保留策略，而不是简单删除所有历史。
- `/health` 永远返回 `ok`，见 `app/main.py:236-238`；对单机运维仍有价值但不是核心功能阻断，列为 P2，建议另增 readiness 或在 UI 显示 FFmpeg/上游连接测试结果。

## 九、校准后的问题清单

### P1：影响单机日常使用和长期运行

1. **实时会话失败后未调用 DELETE，可能耗尽本机实时配额。** `frontend/src/components/RealtimeRecorderPanel.tsx:80-91`、`216-242`；当前上限为 4，`app/config.py:60-68`。
2. **“清空”不取消服务端文件任务，后台仍可能继续识别并写结果。** `frontend/src/App.tsx:318-321`、`frontend/src/hooks/useFileTask.ts:69-95`；应同时补输出/临时资源的保留和清理策略。
3. **实时容量检查在锁外，快速重复创建可能绕过上限。** `app/services/realtime_manager.py:173-201`。
4. **`.env` 已跟踪且权限为 0644，未来填入密钥后容易进入内网 Git 历史。** `.gitignore:6`，Git index 中存在 `.env`。
5. **Google Fonts 外部依赖影响 air-gapped 首屏字体稳定性。** `frontend/index.html:8-10`；若部署环境确实无外网，按 P1 修复，若有缓存/外网则降为 P2。
6. **默认 realtime provider 是 mock，实时页需要更明显地提示当前为演示模式。** `app/config.py:56`、`.env.example:60`、`frontend/src/components/ConfigView.tsx:20-25`。这是弱 P1，优先级低于资源清理。
7. **offline realtime 只限制单 chunk，不限制会话累计音频。** `app/services/realtime_manager.py:241-259`、`app/services/asr/realtime_offline.py:47-52`、`83-115`。长时间录音可能消耗自身内存和临时磁盘。

### P2：工程门禁、吞吐和体验打磨

1. **前端 lint 1 项、Ruff 5 项未通过，CI 也没有 lint 门禁。** `frontend/src/components/ConfigView.tsx:207`、`.github/workflows/ci.yml:54-60`。
2. **任务级 ASR semaphore 不是进程级总闸门。** `app/services/stream_manager.py:580-584`。
3. **旧 `/transcribe-stream` session 无完成清理/TTL。** `app/services/stream_transcribe_manager.py:25-33`、`166-172`。
4. **SSE 断线后前端直接关闭，未利用后端事件回放。** `frontend/src/hooks/useFileTask.ts:162-231`、`app/api/routes.py:829-836`。
5. **一级工作区状态不进入 URL。** `frontend/src/App.tsx:37-47`。
6. **部分交互元素的键盘/ARIA 语义需要修正。** `frontend/src/components/SegmentList.tsx:123-145`、`frontend/src/components/HistoryView.tsx:191-196`。
7. **运行时配置写入没有临时文件+原子替换。** `app/config.py:208-226`；单机低并发下概率低，但配置损坏后排障成本高。
8. **健康检查只验证进程存活。** `app/main.py:236-238`、`docker-compose.prod.yml:32-35`。
9. **Vite 脚手架资源和两套视觉 token 残留。** `frontend/src/assets/react.svg`、`vite.svg`、`hero.png`、`frontend/src/App.css:1-184`、`frontend/tailwind.config.js:9-20`。

### P2：未来扩大暴露面时的前置清单

1. 生产环境强制鉴权和配置管理员权限。
2. `/asr/models` 上游 allowlist、出站网络控制和重定向限制。
3. task/session owner、角色/租户隔离和审计日志。
4. 多 worker/多副本的共享任务状态、事件存储和队列。

这些不是当前单用户内网版本的上线阻断项，但应在产品定位变化前重新审查，不能因为当前降级就永久删除风险记录。

## 十、改进顺序

### 第一优先级：1-2 天内处理

1. 将 `resetTask` 改为：存在 task ID 时先请求 cancel，关闭 SSE 后再清理前端状态；取消失败要显示状态，不要静默丢弃。
2. 实时录音创建 session 后的任何异常都进入统一 `finally`，若已有 session ID 就调用 DELETE；组件卸载、停止失败和麦克风拒绝都覆盖同一条清理路径。
3. 将实时容量统计和 session 插入放入同一个锁临界区，或使用原子计数；增加并发创建测试。
4. 增加 realtime session 累计字节/时长上限，并在前端显示“已发送/剩余配额”。
5. 明确定义 output 保留策略：按天数、总磁盘占用或手动保留；对已取消/失败任务及时清理临时文件，对结果文件提供批量清理或自动归档。

### 第二优先级：内网交付体验

1. 将字体改为自托管或稳定的本地字体栈；把当前实时 provider 在实时页面顶部以明确 badge 展示，`realtime_mock` 显示“演示模式，不调用真实 ASR”。
2. 从 Git index 移除 `.env`，修改 `.gitignore` 覆盖 `.env`，检查历史并轮换曾经写入过的凭据；不提交用户真实配置。
3. 清理 lint/Ruff，并在 CI 加入 `npm run lint` 和 `ruff check` 门禁。

### 第三优先级：稳定性和细节

1. 统一全局 ASR semaphore、清理旧 stream session、补配置原子写入和 readiness 检查。
2. 增加 SSE 重连/事件游标、URL 工作区状态和键盘语义修复。
3. 删除脚手架资源，并统一 `index.css` 与 `tailwind.config.js` 的设计 token。

## 十一、验证记录与限制

- 上一轮同一代码版本验证：后端 `pytest -q` 为 174 passed。
- 前端 `npm test -- --run` 为 8 个测试文件、25 tests passed。
- `npm run build` 成功；JS 约 423.92 kB（gzip 132.47 kB），CSS 约 44.12 kB（gzip 7.97 kB）。
- `docker compose config --quiet` 通过。
- `npm run lint` 失败 1 项；`ruff check app asr-deploy-code` 失败 5 项。
- `mypy`、`bandit`、`pip-audit` 当前环境不可用；没有完成依赖漏洞扫描。
- 没有运行真实麦克风、真实 ASR、浏览器移动端截图和长时间压力测试；关于字体超时、session 配额自锁和长录音内存压力，报告基于静态控制流和配置推断，建议用 Playwright/长时测试确认。
- 本校准任务按要求并行尝试了 Antigravity 与 Claude 分析，但 Antigravity 被 headless command 权限策略拒绝，Claude 以 exit 1 退出，均没有有效模型报告。因此本报告以用户给定的场景边界、仓库证据和本地验证为依据。

## 十二、评分理由

建议按以下分项理解 7.6 分：

| 分项 | 分数 | 理由 |
| --- | ---: | --- |
| 项目概览与组织 | 8.2 | 定位、目录、部署材料和 provider 边界清楚。 |
| 后台 UI/UX | 7.8 | 主工作区、组件风格、空态和移动抽屉完整；导航持久化、断线恢复和部分可访问性仍需打磨。 |
| 功能逻辑 | 7.5 | 主链路闭环且测试覆盖好；资源清理和并发边界影响长期使用。 |
| 完整度 | 8.0 | 对单机工具功能较全，默认 mock 和保留策略是主要缺口。 |
| 代码质量与安全 | 7.5 | 模块化和测试强；lint/Ruff、`.env` 卫生未闭环，公网安全项不计为当前阻断。 |
| 性能与长期运行 | 7.1 | 单机架构匹配场景；session 累计、任务取消、输出保留和旧 session 回收需要补强。 |

加权后总体为 **7.6 / 10**。与上一版 6.3 分的差异主要来自删除了不适用于当前定位的公网认证、越权、多租户和分布式扩展扣分；保留的 2.4 分扣减来自资源生命周期、长期运行、离线字体、默认行为提示、`.env` 和工程门禁。
