# Qwen3-ASR 流式服务 · CUDA 部署

`asr-deploy-code/` 的容器封装，跑通用 N 卡。昇腾 NPU 版在 `../qwen3-asr-npu/`。

## 前置条件

- 宿主机 NVIDIA 驱动 + `nvidia-container-toolkit`
  ```bash
  docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu22.04 nvidia-smi
  ```
- 模型权重已下载到宿主机，例如 `/home/models/Qwen3-ASR-1.7B`

## 部署

改 `docker-compose.yml` 里两处（都标了 `←`）：权重挂载路径、`ASR_API_KEY`。
然后在**仓库根目录**执行：

```bash
docker compose -f deploy/qwen3-asr-cuda/docker-compose.yml up -d --build
curl http://127.0.0.1:8030/readyz     # 模型后台加载，首次约 1~2 分钟
```

`build context` 必须是仓库根目录（compose 里已配好 `context: ../..`），因为镜像要
`COPY asr-deploy-code/`。

## MediaFlow 侧配置

服务配置页面有两个区块，用的是同一个服务的两套接口，**不要串**：

| 区块 | 填什么 |
| --- | --- |
| 实时流式 `realtime_ws` | `ws://<宿主机IP>:8030/v1/asr/stream` |
| 整段转写 `openai_compat` | `http://<宿主机IP>:8030/v1` |

整段转写要填到 `/v1` 根（客户端自己接 `/audio/transcriptions`），且 scheme 必须是
`http` —— 服务不说 HTTPS，填 `https` 会报 `[SSL: WRONG_VERSION_NUMBER]`。

## 几个容易踩的点

- **`ASR_DTYPE`**：默认 `bfloat16`。不支持 bf16 的老卡改 `float16`。
- **并发**：`ASR_MAX_CONCURRENCY` / `ASR_PARTIAL_CONCURRENCY` 就是真实上限，
  `bind_loop()` 会按两者之和开等大的推理线程池。调高前先确认显存。
- **`ASR_STREAM_TOKEN_LEVEL`**：`qwen_asr` 后端不暴露 `TextIteratorStreamer`，
  会自动降级成整句返回，所以 delta 粒度是按句而不是按 token，这是预期行为。
- **语言**：上游只认全称（`Chinese`），传 `zh` 会被内部 `capitalize()` 成 `Zh`
  后拒掉。MediaFlow 的 `realtime_ws` provider 已经会自动翻译，直连时要自己注意。
- **镜像不含权重**：换模型只改挂载路径和 `ASR_MODEL_PATH`，不用重建镜像。
