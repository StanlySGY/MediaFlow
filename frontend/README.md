# MediaFlow · 前端

MediaFlow 的 Web UI：React 19 + TypeScript + Vite + Tailwind CSS。提供文件转写、实时识别、服务配置、历史记录四个 tab，以及拖拽上传、实时分片进度、播放联动校对、字幕导出等交互。

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
├── App.tsx              页面外壳：路由、顶栏状态、布局；业务逻辑下沉到 hooks
├── components/          展示组件（Sidebar / Header / Dropzone / SegmentList / RealtimeView / ConfigView / HistoryView / Accordion）
├── hooks/
│   ├── useAuth.ts       Bearer Token 存取 + 401 自动续填 + SSE 鉴权 URL
│   ├── useEventSource.ts SSE 订阅封装（句柄随渲染刷新，订阅不重建）
│   └── useFileTask.ts   文件转写全生命周期：上传(XHR 进度)/SSE 分片流/轮询/结果/校对/字幕导出
├── lib/
│   ├── subtitle.ts      SRT/VTT 生成（镜像后端 app/services/subtitles.py，含 *.test.ts）
│   └── download.ts      浏览器下载 + 时长格式化（含 *.test.ts）
├── types.ts             与后端对齐的数据结构
└── test/setup.ts        Vitest 全局 setup（jest-dom matchers）
```

测试用 Vitest + jsdom + Testing Library，覆盖字幕纯函数、`useAuth`、`App` 冒烟渲染。测试文件 (`*.test.ts(x)`) 已从 `tsc -b` 构建中排除，由 Vitest 单独运行。
