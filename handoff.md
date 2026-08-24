# Handoff — Qwen3-ASR 流式接入 / AutoDL 部署

> 用法：下次开新会话时说一句「读取 handoff.md 恢复上下文」即可继续。
> 最后更新：2026-08-24。写这份文档时 git HEAD = `132ce81`（branch `main`，工作区干净，remote `git@github.com:StanlySGY/MediaFlow.git`）。

## 背景一句话

现场用的是 Qwen3-ASR 原生 WebSocket 流式接口（`realtime_ws`），你自己要在 AutoDL 上另起一套用于本地验证的服务，用的是仓库自带的 `deploy/qwen3-asr-npu/streaming_server/server.py`——这套走的是 **HTTP + SSE**，对应 MediaFlow 里的 `realtime_http` provider，**不是** `realtime_ws`。

**部署到 AutoDL 后，MediaFlow 侧要配：实时接口类型 = `realtime_http`，实时接口地址 = `http://<AutoDL映射地址>`（不带路径后缀）。** 配成 `realtime_ws` 会连不上。

这意味着 AutoDL 自建环境测不到现场那条 `realtime_ws` 代码路径（`app/services/asr/realtime_ws.py`），但对当前要验证的东西——SSE 契约、前端渲染、全量 vs 分句——完全够用，因为 MediaFlow 推给调用方的 SSE 格式跟用哪个 provider 无关（两条 provider 路径最终都会喂给同一套下游 SSE 格式）。

---

## ⏸️ 悬而未决：等你答复才能继续

**问题**：MediaFlow 目前不管走 `realtime_http` 还是 `realtime_ws`，推给前端的都是"全量文本"（每次推送都是从头到尾的完整识别结果），不是增量/分句。这是要现在改成分句下发（加 `delta` 字段或按句切 `segment_id`），还是等对方（前端）这版先跑通再改？

上一次对话中我已经把方案想清楚了，只是在等这个决策：
- **倾向的方案**：在 MediaFlow 层做差分——记住上次推送给下游调用方的文本，只发新增部分。这个改动小，对 `realtime_http` 和 `realtime_ws` 两个 provider 通吃（因为两条路径殊途同归，最后都在 MediaFlow 里拼出全量字符串再往外推，差分逻辑加在这个"往外推"的环节即可）。
- **代价**：这是对外 SSE 契约变更，前端说明文档要重写。
- **两个选项**：
  1. 现在改（对方前端还没写完对接代码，一次到位，不用改两次）
  2. 等现在这版全量方案先联调跑通，确认端到端没问题后再切分句

**一旦你给出决定，直接告诉我"现在改"或"先不改"，我就能继续动手，不用重新解释背景。**

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

## 下一步（等你回答完悬而未决的问题后）

1. 按你的决定，动手改/不改分句契约。
2. 按上面步骤在 AutoDL 开 4090/3090 实例，部署 `streaming_server`。
3. 把 AutoDL 映射地址配进 MediaFlow（`realtime_http`），联调验证 SSE 契约、前端渲染。
4. 遇到 `qwen-asr[vllm]` 安装报错或 HF 模型名不对，把报错贴过来。

## 关于本文件维护的提醒（用户偏好，来自 memory）

- 完成代码改动后要主动 push 到 main，并给出 build 命令（不用等用户问）。
- 这个仓库里有多 GB 的离线交付 tar 包（`vllm-ascend-*.tar.gz`、`vllm-part-*`），**任何时候都不要 `git add -A`**，要精确 add 改动的文件。
