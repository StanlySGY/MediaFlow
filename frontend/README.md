# MediaFlow · 前端

MediaFlow 的 Web UI：React 19 + TypeScript + Vite + Tailwind CSS。七个视图——文件转写、实时识别、历史记录、音视频合并、服务配置、调用监控、接口调试——以及拖拽上传、实时分片进度、播放联动校对、字幕导出等交互。

## 与后端的关系

- 生产构建产物输出到 `../app/web/`（见 `vite.config.ts` 的 `build.outDir`），由 FastAPI 在根路径 `/` 直接托管。**前端不单独部署**——`docker compose up` 时由多阶段 Dockerfile 在镜像内 `npm run build`。
- 开发模式下 `vite dev` 已在 `vite.config.ts` 配好 proxy，把 `/asr`、`/auth`、`/health` 转发到 `http://localhost:8999`。因此本地开发需先在 8999 端口起后端（`uvicorn app.main:app --port 8999`）。

## 开发

```bash
npm install
npm run dev          # http://localhost:5173 ，API 自动代理到 8999
```

## 构建 / 测试 / 检查

```bash
npm run build        # tsc -b && vite build → ../app/web
npm test             # vitest run（CI 使用）
npm run test:watch   # 监听模式
npm run lint         # eslint
```

## 目录结构

```
src/
├── App.tsx              页面外壳：hash 路由、顶栏状态、按视图写 document.title；业务逻辑下沉到 hooks
├── components/          展示组件，与侧边栏七个视图一一对应
│   ├── Sidebar / Header / Dropzone / SegmentList / Dialog / ConfirmDialog / TokenDialog
│   ├── Dialog / ErrorBoundary / HistoryTranscriptDialog / Accordion / AudioLevelMeter
│   ├── ConcatView / ConfigView / HistoryView / MonitorView(+Monitor*) / RealtimeView
│   ├── RealtimeApiDebugView
│   └── RealtimeRecorderPanel.tsx   浏览器录音：麦克风 → WebM/Opus → base64 分帧推送。不含 React 的那半在 lib/realtimeRecording.ts
├── hooks/
│   ├── useAuth.ts       Bearer Token 存取 + 401 自动续填 + SSE 鉴权 URL
│   ├── useEventSource.ts SSE 订阅封装（句柄随渲染刷新，订阅不重建）
│   ├── useFileTask.ts   文件转写全生命周期：上传(XHR 进度)/SSE 分片流/轮询/结果/校对/字幕导出
│   └── useMediaQuery.ts 桌面/窄屏判定（侧边栏折叠）
├── lib/                 与 React 无关的纯函数，每个模块带同名 *.test.ts
│   ├── subtitle.ts      SRT/VTT 生成（镜像后端 app/services/subtitles.py）
│   ├── splice.ts        分片校对写回完整文本
│   ├── download.ts      浏览器下载 + 字节/时长格式化
│   ├── errors.ts        错误体 → 中文文案（服务端 code/hint/retryable 优先）
│   ├── labels.ts        provider / 切分策略 / 实时 provider 的中文表（多页共用同一张表）
│   ├── hashRoute.ts     `#/view` 路由与历史筛选的读写
│   ├── uploadPreflight.ts 上传前校验扩展名与体积（镜像后端限制，避免传到一半才 413）
│   ├── realtimeCueTracker.ts 按上游 final 帧记字幕切点
│   ├── realtimeRecording.ts  容器选择 / 文件名 / 麦克风错误文案 / blob→base64
│   ├── asrMonitor.ts    调用监控的指标聚合
│   └── zip.ts           打包下载
├── types.ts             与后端对齐的数据结构
└── test/
    ├── setup.ts         Vitest 全局 setup（jest-dom matchers）
    └── realtimeMocks.ts SSE / fetch 假实现，供实时相关测试复用
```

测试用 Vitest + jsdom + Testing Library（当前 22 个测试文件 / 154 条）：`lib/` 十个纯函数模块、`useAuth` 与 `useFileTask`、八个视图组件，加 `App` 的冒烟与冷启动标题两条。测试文件 (`*.test.ts(x)`) 已从 `tsc -b` 构建中排除，由 Vitest 单独运行。
