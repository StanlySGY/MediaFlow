# Handoff — Qwen3-ASR 流式接入 / AutoDL 部署

> 用法：下次开新会话时说一句「读取 handoff.md 恢复上下文」即可继续。
> 最后更新：2026-08-24。写这份文档时 git HEAD = `ae1b073`（branch `main`，已 push 到远端，工作区干净，remote `git@github.com:StanlySGY/MediaFlow.git`）。

## 背景一句话

现场用的是 Qwen3-ASR 原生 WebSocket 流式接口（`realtime_ws`），你自己要在 AutoDL 上另起一套用于本地验证的服务，用的是仓库自带的 `deploy/qwen3-asr-npu/streaming_server/server.py`——这套走的是 **HTTP + SSE**，对应 MediaFlow 里的 `realtime_http` provider，**不是** `realtime_ws`。

**部署到 AutoDL 后，MediaFlow 侧要配：实时接口类型 = `realtime_http`，实时接口地址 = `http://<AutoDL映射地址>`（不带路径后缀）。** 配成 `realtime_ws` 会连不上。

这意味着 AutoDL 自建环境测不到现场那条 `realtime_ws` 代码路径（`app/services/asr/realtime_ws.py`），但对当前要验证的东西——SSE 契约、前端渲染、全量 vs 分句——完全够用，因为 MediaFlow 推给调用方的 SSE 格式跟用哪个 provider 无关（两条 provider 路径最终都会喂给同一套下游 SSE 格式）。

---

## ✅ 已完成：分句契约（delta 字段）

上次决策是「先改」，方案 A（加 delta 字段，向后兼容），已经改完并 push 到 main（commit `ae1b073`）。

- `app/models/schemas.py`：`ASRStreamEvent` 新增 `delta: str` 字段（默认 `""`），`text` 字段的 docstring 更新为明确说明"始终是全量文本"。
- `app/api/routes.py`：
  - 新增 `_realtime_delta(previous_text, full_text)` 纯函数：对 `full_text` 相对 `previous_text` 做前缀差分，非前缀增长（模型改写/缩短了输出）时退化为整段 `full_text`，绝不丢信息。
  - `_standard_realtime_sse_message()` 签名改为 `(evt, *, previous_text="")`，`previous_text` 由调用方（每个 SSE 连接自己）维护，**不是**按 `session_id` 存的全局/共享状态——因为同一个 realtime session 可能有多个并发订阅者各自重放同一份事件历史（`test_multiple_subscribers_each_get_all_events`），一个全局 dict 会让它们互相污染 delta 基准。
  - `stream_realtime_session()` 里的 `event_gen()` 在本地维护 `previous_text` 局部变量，逐个事件更新。
  - `_standard_file_segment_sse_message()`：文件流每个 segment 本身就是独立分片，`delta` 恒等于 `text`。
  - `REALTIME_EVENTS_DOC`、`STANDARD_FILE_EVENTS_DOC`、两处 OpenAPI response example 都加了 `delta` 字段说明和示例。
- `app/main.py`：顶部 `API_DESCRIPTION` 里的 SSE 示例和文字说明同步加了 `delta`。
- 前端：`frontend/src/types.ts` 的 `StandardASRStreamEvent`/`RealtimeEvent` 都加了 `delta?: string`；`RealtimeView.tsx`、`RealtimeRecorderPanel.tsx` 透传 `delta`（渲染逻辑本身没改，前端目前仍按 `text` 全量渲染，`delta` 字段已经在事件对象里，后续要做打字机效果时前端可以直接用）。
- 测试：`tests/test_standard_sse_format.py` 更新了旧断言（`==` 全字典比较加了 `delta` 键），新增 3 个测试专门验证 delta 前缀差分/回退整段/done-error 时 delta 恒为空；`tests/test_realtime_routes.py` 新增一个端到端 SSE 流测试验证 `delta` 字段真实出现在 HTTP 响应流里。
- 全部通过：后端 `pytest` 129 passed；前端 `tsc -b --noEmit` 无错、`vitest run` 16 passed。

**注意**：这次只加了 `delta` 字段，**没有**动 `deploy/qwen3-asr-npu/streaming_server/server.py`（AutoDL 上要部署的那个上游服务）和 `app/services/asr/realtime_ws.py`（现场 WebSocket provider）的内部逻辑——它们继续往 `RealtimeASREvent.text` 里塞全量文本，差分是在 MediaFlow 网关层（`_standard_realtime_sse_message`）统一做的，两个 provider 不用改，这也是设计这个方案时特意要达到的效果（对两个 provider 通吃）。

---

## 悬而未决：无（截至本次更新）

上一轮的分句契约问题已经解决。目前没有阻塞性决策待你回复；下一步是 AutoDL 部署联调（见下方问题 2/3），如果部署或联调中出现新的分支决策，会更新在这里。

---

## 问题 1：为什么是全量文本，不是分句增量

根因在 `deploy/qwen3-asr-npu/streaming_server/server.py:221-224`：

```python
text = s.state.text or ""
if text and text != s.last_text:
    s.last_text = text
    _emit(s, "online", text=text, is_final=False)
```

`state.text` 是 qwen-asr 流式接口自己维护的**累计全文**（`model.streaming_transcribe` 每次调用后，`state.text` 就是从会话开始到现在识别出的全部文字），`streaming_server` 原样转发，没有做任何裁剪。

- **`realtime_http` 路径**（`app/services/asr/realtime_http.py`）：直接透传上游 SSE 里的 `text` 字段 → 全量。
- **`realtime_ws` 路径**（`app/services/asr/realtime_ws.py`，核心逻辑在 `_render_text`/`_dispatch_server_frame`，约第 455-608 行）：MediaFlow 自己按 `segment_id` 拼接多个 segment 的文字重建出全量字符串，再往外推 → 也是全量。

**结论**：两条路径都是全量，这是上游 Qwen3-ASR API 的形态（`state.text` 语义）决定的，不是某处代码疏忽。要改成分句/增量，必须在 MediaFlow 这层加一层"记住上次推送内容、算 diff"的逻辑，两个 provider 各自的 `_emit_text` / 对应转发点都要接入这层逻辑。

---

## 问题 2：AutoDL 选卡 —— 已定论，直接照做

- **模型**：Qwen3-ASR-1.7B，bf16 权重约 3.4GB。
- **真正吃显存的是 vLLM 的 `GPU_MEMORY_UTILIZATION=0.9`**（`server.py:49`）——它会预占整卡 90% 显存做 KV cache，跟模型本身多小无关。
- **推荐**：RTX 4090 24GB（单流延迟看主频，4090 更快；24GB 不用调参直接能跑）。
- **备选更便宜**：RTX 3090 24GB 也够，慢一些。
- **不建议 16GB 以下**：不是装不下模型，是 `max_inference_batch_size=32`（`server.py:79`）+ `max_new_tokens` 偏大，容易 KV cache 不够。真要省钱，把 `GPU_MEMORY_UTILIZATION` 调到 0.5 能在 16GB 卡上跑。
- **存储**：模型约 3.4GB，AutoDL 系统盘小，模型要下到**数据盘**（如 `/root/autodl-tmp/`）。

---

## 问题 3：AutoDL 部署步骤 —— 已定论，直接照做

现有 `deploy/qwen3-asr-npu/streaming_server/Dockerfile` 基于 `quay.io/ascend/vllm-ascend`（华为昇腾 NPU 镜像），**在 N 卡上跑不了**，AutoDL 上不要用这个 Dockerfile，直接在实例里裸跑更省事：

```bash
# 1. 选 PyTorch 2.x + CUDA 12.x 官方镜像开实例（4090 24GB）

# 2. 装依赖
pip install "qwen-asr[vllm]" fastapi uvicorn numpy
apt-get update && apt-get install -y ffmpeg

# 3. 下模型到数据盘（AutoDL 内网走 hf-mirror 更快）
export HF_ENDPOINT=https://hf-mirror.com
pip install huggingface_hub
huggingface-cli download Qwen/Qwen3-ASR-1.7B --local-dir /root/autodl-tmp/Qwen3-ASR-1.7B

# 4. 把 deploy/qwen3-asr-npu/streaming_server/server.py 传上去

# 5. 起服务
export MODEL_DIR=/root/autodl-tmp/Qwen3-ASR-1.7B
export GPU_MEMORY_UTILIZATION=0.9
export CHUNK_SIZE_SEC=2.0
uvicorn server:app --host 0.0.0.0 --port 8001

# 6. 自检
curl http://127.0.0.1:8001/health     # 期望 {"status":"ok","model_loaded":true}
```

然后 AutoDL 开**端口映射**（自定义服务），把公网地址填进 MediaFlow：
- 实时接口类型 = `realtime_http`
- 实时接口地址 = 映射出来的 `http://...`（不带路径）

`CHUNK_SIZE_SEC` 是延迟旋钮：调到 1.0 出字更快但推理更频繁；先用 2.0 跑通再调。

### 两个没法预先验证、卡住了发我报错即可的风险点
1. `qwen-asr[vllm]` 这个包在 CUDA 环境下能否正常装（现场是 Ascend NPU 分支，没在 CUDA 上验证过依赖树）。
2. HF 上 `Qwen/Qwen3-ASR-1.7B` 这个仓库名是否确切（没有实际访问过 HF 确认）。

---

## 涉及到的关键文件（下次直接读这些就能接上）

| 文件 | 作用 |
|---|---|
| `deploy/qwen3-asr-npu/streaming_server/server.py` | 你要部署到 AutoDL 的服务，HTTP+SSE，核心累计文本逻辑在第 221-224 行 |
| `deploy/qwen3-asr-npu/streaming_server/Dockerfile` | 现有 Docker 镜像，基于昇腾 NPU，**AutoDL 上不能用** |
| `app/services/asr/realtime_http.py` | MediaFlow 内 `realtime_http` provider，透传下游 SSE |
| `app/services/asr/realtime_ws.py` | MediaFlow 内 `realtime_ws` provider，自己拼 `_render_text`（约 455-608 行），对应现场环境 |
| `app/services/asr/realtime_registry.py` | provider 注册表，`realtime_http`/`realtime_ws` 两个 key |
| `STREAMING_ONSITE_DEPLOY.md` / `ONSITE_DEPLOY.md` / `DEPLOY_ONSITE.md` | 现场部署相关既有文档 |

## 下一步

1. ~~分句契约~~ 已完成，见上方「✅ 已完成」章节。
2. 按上面步骤在 AutoDL 开 4090/3090 实例，部署 `streaming_server`。
3. 把 AutoDL 映射地址配进 MediaFlow（`realtime_http`），联调验证 SSE 契约、前端渲染、`delta` 字段是否符合预期。
4. 遇到 `qwen-asr[vllm]` 安装报错或 HF 模型名不对，把报错贴过来。

## 关于本文件维护的提醒（用户偏好，来自 memory）

- 完成代码改动后要主动 push 到 main，并给出 build 命令（不用等用户问）。
- 这个仓库里有多 GB 的离线交付 tar 包（`vllm-ascend-*.tar.gz`、`vllm-part-*`），**任何时候都不要 `git add -A`**，要精确 add 改动的文件。
