# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
版本号的落点：`app/main.py` 的 FastAPI `version`、`frontend/package.json`、`build.sh` 的 `DEFAULT_TAG` 与 `docker-compose.prod.yml` 引用的 `mediaflow:<版本>` 四处保持一致。

仓库里真实出现过的版本落点只有 `0.1.0 → 1.2.0 → 1.3.0 → 1.4.0 → 1.4.1 → 1.7.0 → 1.7.1 → 1.7.2 → 1.7.3 → 1.8.0 → 1.8.1 → 1.8.2 → 1.8.3 → 1.8.4`：`1.5.x` / `1.6.x` 从未使用；`1.3.1` 只在 2026-07-28 一次提交的 `frontend/package.json` 里出现，随即被 `1.4.1` 覆盖，`build.sh` / `app/main.py` / `docker-compose.prod.yml` 三处从未跟进，因此不单独列为一个发布。首个 git tag 是 `v1.7.3`（2026-10-19 切出，版本号本身落点在 2026-09-23 的 `a34b62d`）。

## [1.8.4] - 2026-10-23

### 修复
- **镜像构建在代理链路上随机失败**（三条层各自修）：
  - `npm ci` 静默漏装可选依赖。症状是 `RUN npm run build` 报 rolldown `Cannot find native binding`，根因却在安装层：rolldown 的原生绑定是**可选依赖**，npm 拉那个 ~8.8 MB tarball 失败时不把 install 判为失败、只是略过它，于是这一层被当成成功层缓存下来，缺绑定要等好几层之后才爆（npm/cli#4828）。现在 stage 1 改 `node:20-slim` → `node:22-slim`（与 CI `setup-node: 22`、开发宿主一致），并在 `npm ci --include=dev` 后 `import('rolldown')` 校验完整性，整层重试——缺绑定在安装层失败重跑，不会缓存成坏层。
  - `apt-get install ffmpeg` 无重试。ffmpeg 要拉 ~200 个包，一个 `.deb` 超时（`Connection timed out`）就让整层 `exit 100`。给 apt 显式加 `Acquire::Retries=5` / `Acquire::http(s)::Timeout=30`。
  - `pip install -r requirements.txt` 被代理**中途断链**。症状是 `ProtocolError: Connection broken: BrokenPipeError`，不是请求超时，所以 `PIP_RETRIES` 帮不上（它只重发 HTTP 请求，不管传到一半的响应体）。改为整层重试，并在每次成功后逐个核对 `requirements.txt` 里的 pin 是否真的装成那个版本——「装成功但少了东西」同样会缓存成好层、到运行时才炸。核对逻辑双向验证过：正常镜像里 11 个 pin 全通过；把 pin 改成不存在的版本时该层失败。
  - 核对本身的第一版写法带噪声：`pip freeze | grep -qiE …` 里 `grep -q` 命中即退出，`pip freeze` 收到 SIGPIPE，构建日志在正确判定旁边多出一段 `freeze.py … BrokenPipeError` 的 traceback，而且一次核对要跑 11 次 `pip freeze`。改为把 `pip freeze` 取一次存进变量、逐个 pin 匹配同一份副本（grep 读完整个输入才退出，不会断管）。修后实测：真镜像里 exit 0、零 `pin not satisfied`、无 traceback；反向对照（pin 改成 `pydantic==9.9.9`）exit 1、1 条 `pin not satisfied`、5 次重试、无 traceback；随后的 `./build.sh` 里 pip 层 26.5s 通过、重试 0 次。
- **交叉架构构建没有护栏**：`./build.sh` 本来就按 `uname -m` 选本机架构（`--platform` 只在显式传入时才进 `docker build`），但传一个与宿主不符的 `--platform` 时它照跑不误，每一层都在 QEMU 模拟下执行——apt/pip 层耗时是原生的数倍，超时概率也高得多，而这正是两份现场手册反复要求「在与现场同架构的打包机上构建」的原因。现在这种调用会先警告，并且当 daemon 根本没注册对应模拟器时直接失败并给出注册命令。交付路径本身不变：在与目标同架构的机器上 `./build.sh --save`，不需要 `--platform`。
- 版本号 1.8.4（`app/main.py`、`frontend/package.json`、`build.sh`、`docker-compose.prod.yml` 四处一致，文档里的 tarball 名同步）。

## [1.8.3] - 2026-10-23

### 修复
- **深链接打开的页面标签仍是通用标题**：1.8.1 给每个视图写了 `document.title`，但调用点只有 `handleViewChange` 和 `hashchange` 监听 —— 冷启动直接打开 `#/history`（书签、分享的链接）时这两个都不运行，标签条上还是 `MediaFlow · 音视频处理`，恰恰是这次改动要解决的场景。改为在 `currentView` 上一个 effect 统一设置：挂载、点导航、前进/后退三条路径共用一处，原来的两个调用点删掉。`App.title.test.tsx` 用 `#/history` 冷启动复现（修复前 `document.title` 是空字符串）。
- 版本号 1.8.3（`app/main.py`、`frontend/package.json`、`build.sh`、`docker-compose.prod.yml` 四处一致，两份现场部署文档与 README 里的 tarball 名同步）。`v1.8.2` 已推送且不改写已发布 ref，其代码带上述标题缺口，交付构建用 `v1.8.3`。

## [1.8.2] - 2026-10-23

### 修复
- **开机后第一次历史扫描被节流吞掉**：`HistoryIndex` 用 `_last_refresh = 0.0` 表示「从未刷新」，但判断用的是 `time.monotonic()` —— 它从一个任意的过去时刻起算，在一台刚启动不到 `HISTORY_REFRESH_SECONDS`（默认 1s）的机器上，`monotonic()` 的值比这个窗口还小，于是第一次 `refresh()` 被当成「窗口内」直接返回，归档读出来是空的；写任务结束时调的 `invalidate()` 同理失效，刚完成的任务在开机头一段时间里不进历史列表。本地 `monotonic()` 恒为几万秒，所以这个 bug 只在 CI（新起的 runner）暴露：`test_refresh_is_throttled_unless_forced` 报 `assert 0 == 1`。哨兵改为 `None`，「是否已经刷新过」不再靠时钟值猜。测试用 `monkeypatch` 把时钟拨到 5.0s 复现，回退修复后以同一症状失败。
- **CI 矩阵互相顶替**：`test` job 的矩阵是默认 `fail-fast: true`，3.11 失败会取消 3.12，那个 job 在页面上显示为 `-`（实际它的 pytest 已经 `276 passed`），一个 3.11 专属故障看起来像「到处都坏了」。改为 `fail-fast: false`，两个版本各自报告结果。
- **CI 的 Node 版本**：`setup-node` 的 `node-version: 20` 已被 GitHub 强制跑在 Node 24 上并每次发弃用警告，改为 22（与本地开发环境一致）。
- **CI 工作流的 action 大版本**（v1.8.2 tag 之后补入，只动 `.github/workflows/`，不进交付镜像）：上一条只改了 `node-version`，但弃用警告针对的是 action **自身声明**的运行时的 —— `checkout@v4` / `setup-python@v5` / `setup-node@v4` / `configure-pages@v5` / `deploy-pages@v4` 的 `action.yml` 写的都是 `using: node20`，GitHub 把它们强行跑在 Node 24 上并在每次 run 结束时报警告。核实各 major 的 `using:` 后升 `checkout@v7`、`setup-python@v7`、`setup-node@v7`、`configure-pages@v6`、`upload-pages-artifact@v5`（其内部嵌套的 `upload-artifact` 也从 v4 的 node20 换到 v7 的 node24）、`deploy-pages@v5`。`checkout@v7` 的唯一行为变化是 `pull_request_target` / `workflow_run` 下拒绝检出 fork PR，本仓库这两个触发方式都没用到。
- 版本号 1.8.2（`app/main.py`、`frontend/package.json`、`build.sh`、`docker-compose.prod.yml` 四处一致）。`v1.8.1` tag 已推送、不改写已发布的 ref，所以这个修复单独发一个补丁版；**`v1.8.1` 那个 tag 的代码带上述历史列表 bug，不要用它构建交付**。

## [1.8.1] - 2026-10-23

### 修复
- **配置页会把已保存的接入配置清空**：`/asr/config`（只含全局字段）在 `/asr/profiles` 之后到达时，用一份不含地址、模型、接口类型的表单**整体替换**了表单。页面上看到的是空的实时/文件服务地址与 `—` 接口类型，而点一次「保存这份配置」会把空值写回档案——一次页面加载变成一次静默的数据丢失。现在改为合并（只覆盖它真正负责的全局字段）。`ConfigView.test.tsx` 用「先 profiles、后 config」的真实到达顺序复现，并断言随后 PUT 的请求体仍带全部六个档案字段。
- **实时录音没有字幕导出**：实时会话在服务端归档时 `segments: []`（上游帧不带整句时间戳），此前录音结束后只有 TXT。现在按上游判定为整句的 `final` 帧在前端记切点（`lib/realtimeCueTracker.ts`），导出 SRT/VTT；时间来自本次会话的墙钟与这些切点，页面上写明是哪一种（`字幕时间按本次录音的墙钟计时，N 个切点取上游判定为整句的时刻`；一个切点都没有时说明「上游未给出整句切点，导出为一整条」）。切点为空、上游重复改写已发文本、splice 删字符、`elapsed_ms` 乱序都不会产生结束早于开始的字幕或空白条目。
- **音视频合并只有一个转圈**：合并是一个整文件 POST，此前用不带进度的 fetch，几个 GB 的合并从头到尾只有一个 spinner。改回 XHR 取真实上传进度，并在字节送完之后改口说「服务端正在拼接（不重新编码）…」——第二阶段在 FFmpeg 里、无法上报进度，这一点直接说明。新增「取消」按钮，离开页面时中止未完成的请求。失败时把 blob 里的错误体读回来显示服务端原因。
- **分片列表只能靠滚动查找**：几百段的转写结果此前没有搜索。新增按文本或分片号搜索、以及「只看失败（N）」筛选（分片号是上游错误信息引用的编号，所以也能搜）；筛选命中数实时可见，结果为空时给出「查看全部分片」的出路。新识别出的分片只在用户本来就看列表末尾时才把视图拉下去（IntersectionObserver 判定，筛选变窄不滚动）。
- **两个校对区不一致时不报告**：TXT/复制跟随「完整文本」，SRT/VTT 跟随「分片明细」的时间轴（只有分片带 start/end）。手工改过完整文本、又改了分片时，两边悄悄分叉。现在页面说明哪份导出跟哪边，并提供「以分片为准统一」把完整文本挪到带时间轴的一侧。
- **剪贴板失败静默、JSON 导出失败弹 `window.alert`**：复制全文/复制日志改为写入成功后才显示「已复制」，权限被拒时给出页面内可读提示（转写文本与日志仍在屏幕上）；JSON 导出失败改为页内错误块，不再阻塞式弹窗。
- **麦克风不可用时只显示 "Not supported"**：Chrome 在系统没有音频输入设备（远程桌面、无声卡的虚机、不支持录音的浏览器）时抛 `NotSupportedError`，消息就是这两个词。现在换成说明缺什么、去哪儿确认的中文提示。
- **`maxSessions` 异步到达后容量计数卡死**：effect 清理把 `mountedRef` 置 false 后不再恢复，麦克风被拒绝并释放会话之后「在用 1/4 路」仍是旧值。现在每次 setup 恢复该标志，并在 DELETE 完成后重新读取。
- **只有一半页面尊重「减少动态效果」**：`index.css` 的动画抑制覆盖不到 framer-motion 的路由/视图过渡。现在 `MotionConfig reducedMotion="user"` 统一接管。
- **切换视图可能留下空白主区**：外围 `AnimatePresence mode="wait"` 会等嵌套退出动画，主区在切换瞬间是空的（实测从「历史记录」回「文件转写」需要刷新才恢复）。改为立即挂载目标视图，并加全量测试覆盖这条路径。
- **标签页全是同一个标题**：hash 路由的 SPA 只有一个 `<title>`，标签条和书签无法区分是哪个视图。现在按视图写 `document.title`（含前进/后退，那条路径不经过 `handleViewChange`）。
- **同一个枚举值三个页面三种写法**：provider / 切分策略 / 实时 provider 的中文表从配置页抽到 `lib/labels.ts`，侧边栏底部与实时页头部改用同一张表；未知值原样显示，不假装已解释。演示/录完再识别这两种会让人觉得「卡住了」的 provider，说明改成常驻在会话里并带「去服务配置」的入口（此前只在首次配置前的引导里出现，改过一次配置就永久消失）。
- **字节数写法不统一**：实时录音/接口调试/合并页各自 `toLocaleString()` 或自己写的 `formatBytes`，统一改用 `formatSize`。
- **空音频包被报成服务端故障**：`is_final=false` 的空包返回 400，但错误分类落到 `internal_error`（暗示可重试的服务端问题）。现在归类为 `invalid_request` / `retryable: false`。
- **本地 bind mount 属主**：`docker-compose.yml` 的容器用户改为可用 `MEDIAFLOW_UID` / `MEDIAFLOW_GID` 指定（默认仍是镜像内的 10001），仓库 `.env` 设成宿主用户，避免为了可写而 `chown` 数据目录。
- **基础镜像浮动 tag**：`python:3.12-slim` → `python:3.12-slim-trixie`，固定 Debian 发行版，避免 tag 迁移悄悄换掉装 FFmpeg 的系统包集合。
- 删除 `index.css` 里没有任何组件引用的 `.step` / `.step .num` 样式；声音波形与 `prefers-reduced-motion` 块纳入 `@layer`，不再靠未分层规则压过 Tailwind utility。
- 版本号 1.8.1（`app/main.py`、`frontend/package.json`、`build.sh`、`docker-compose.prod.yml` 四处一致）。

## [1.8.0] - 2026-10-20

### 新增
- **上传准入**：`MAX_CONCURRENT_UPLOADS`（默认 2）限制同时进行的上传，超出返回 429 `upload_limit`；`MIN_FREE_DISK_BYTES`（默认 512 MiB）在剩余空间不足时拒绝上传，返回 507 `insufficient_storage`。两项都在读取请求体之前判定，因此被拒的上传不落盘。此前 `ASR_CONCURRENCY` 只约束上游调用，几个客户端同时上传大文件即可把磁盘写满。
- **启动清理 `temp/`**：进程被 `kill -9` 或容器 OOM 时，上传的源文件（任务结束才删除）会一直留在 `temp/`，此前没有任何代码会回收它们。现在启动时在服务接收请求前清空。
- **历史索引**：历史列表改由 `app/services/history_index.py` 缓存，每个归档文件只在 mtime/size 变化时重新解析；`HISTORY_REFRESH_SECONDS`（默认 1.0）限制扫描频率，刚结束的任务会强制刷新。20k 条归档下，一次历史请求从 ~600ms 的全量扫描降到个位数毫秒。
- **安全响应头**：`nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: same-origin` / `COOP`。
- **gzip 与静态资源缓存**：`/assets/*` 带 `Cache-Control: immutable`（配合文件内容哈希），`index.html` 每次校验；构建产物 gzip 后从 460 KB 降到 143 KB。
- **前端错误边界**：渲染异常不再白屏，保留外壳、展示错误信息并提供刷新/回到文件转写。
- **校对同步到全文**：分片校对以前只影响 SRT/VTT，TXT、复制全文与完整包仍导出未校对的原文。现在校对（及撤销）会同步更新「完整文本」，用户手工编辑过的全文不会被覆盖。

### 变更
- **`/docs` 与 `/openapi.json` 需要令牌**：启用 `ACCESS_TOKENS` 后，这两个地址与 API 一样需要鉴权，浏览器可用 `?token=` 或登录后签发的 HttpOnly cookie 进入。此前接口清单在公网/内网共享网段上完全公开。
- **优雅停机**：SIGTERM 后最多等待 8 秒，让实时会话收尾、文件任务在阶段边界停下；超时的任务在下次启动时标记为 `interrupted`（此前直接中断）。
- **容器以非 root 运行**（uid 10001），`temp` / `outputs` / `config` 在镜像内预先创建并授权。
  ⚠️ 宿主机上的 bind mount 需要一次性调整属主：`sudo chown -R 10001:10001 temp outputs config`。
  未调整时容器**拒绝启动**（uvicorn 退出码 3），启动日志逐条指名哪个路径不可写并打印该命令。此前只记 ERROR 就继续启动：容器带着 200 的 `/health` 跑起来，第一次上传、保存配置或打开配置页（`GET /asr/profiles` 会回写配置）才抛 500，现场交付后才会暴露。
- `/asr/transcribe-stream` 的事件历史改为与实时会话一致的 512 条上限。
- 已缓存的历史任务不再每次请求都重新解析 JSON（`_rehydrate` 结果留在有界的内存表里）。
- CI 增加独立的前端类型检查步骤。
- 版本号 1.8.0（`app/main.py`、`frontend/package.json`、`build.sh`、`docker-compose.prod.yml` 四处一致）。
- **默认端口改为 `8999`**（原 `8080`）：`app/config.py`、`Dockerfile`、三份 compose、`.env.example`、前端 dev proxy 与全部文档同步。已在旧端口上运行的实例需要 `PORT=8999` 或直接重建容器。

### 修复
- **历史搜索只能命中前 200 字**：搜索用的文本此前是列表预览的截断版本，长录音中间的一句话搜不到。现在索引保留全文（单条上限 8000 字）用于搜索。
- `stream_transcribe_manager` 的事件列表无上限，长会话会持续占用内存。

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
