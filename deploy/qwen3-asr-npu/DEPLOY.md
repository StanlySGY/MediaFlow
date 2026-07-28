# Qwen3-ASR-1.7B NPU 部署文档

基于 [vllm-ascend](https://github.com/vllm-project/vllm-ascend) 官方支持，参考 [官方部署指南](https://docs.vllm.ai/projects/ascend/en/latest/tutorials/models/Qwen3-ASR-1.7B.html)。

## 一、环境要求

### 硬件

| 芯片型号 | 状态 | 显存要求 |
|----------|------|----------|
| Ascend 910B | ✅ 官方支持 | 1 x 64GB |
| Ascend 310P | ✅ 官方支持 | 1 x 48GB |
| Atlas 300I Duo | ⚠️ 实验性 | - |

### 软件

- Docker + Docker Compose
- NPU 驱动已安装（`npu-smi info` 可正常执行）
- CANN 9.0.1

## 二、快速部署（推荐）

### 1. 进入部署目录

```bash
cd /path/to/MediaFlow/deploy/qwen3-asr-npu
```

### 2. 确认模型文件位置

模型文件应在 `/home/models/Qwen3-ASR-1.7B/` 目录下：

```bash
ls /home/models/Qwen3-ASR-1.7B/
```

如果模型文件在其他位置，修改 `docker-compose.yml` 中的挂载路径。

### 3. 查看 NPU 卡号

```bash
npu-smi info
```

选择一张空闲的卡，记下卡号（0、1、2...）。

### 4. 修改配置（如需要）

编辑 `docker-compose.yml`，修改 NPU 卡号：

```yaml
environment:
  - ASCEND_RT_VISIBLE_DEVICES=0  # 改为实际卡号

devices:
  - /dev/davinci0:/dev/davinci0  # 改为实际卡号
```

### 5. 启动服务

```bash
# 直接启动（推荐，使用官方镜像）
docker-compose up -d
```

### 6. 查看日志

```bash
docker-compose logs -f
```

看到以下内容说明启动成功：

```
INFO:     Started server process [1]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000
```

### 7. 测试接口

```bash
# 查看模型列表
curl http://localhost:8022/v1/models

# 测试音频识别（使用 Chat Completions 接口）
curl http://localhost:8022/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "audio_url",
            "audio_url": {
              "url": "https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_en.wav"
            }
          }
        ]
      }
    ]
  }'

# 测试音频识别（使用 Audio Transcriptions 接口）
curl http://localhost:8022/v1/audio/transcriptions \
  -F "file=@test.wav"
```

## 三、离线部署（服务器无网络）

适用于 NPU 服务器无法联网的场景。需要在本地有网络的机器上准备镜像和模型。

### 步骤 1：在本地机器准备镜像

```bash
# 拉取官方镜像
docker pull quay.io/ascend/vllm-ascend:v0.22.1rc1

# 导出镜像为 tar 文件（约 8-10GB）
docker save quay.io/ascend/vllm-ascend:v0.22.1rc1 -o vllm-ascend-v0.22.1rc1.tar
```

### 步骤 2：传输到 NPU 服务器

```bash
# 方式一：SCP 传输
scp vllm-ascend-v0.22.1rc1.tar user@npu-server:/home/user/

# 方式二：USB 拷贝
# 将文件拷贝到 USB 盘，插入服务器后复制
```

### 步骤 3：在 NPU 服务器导入镜像

```bash
# 导入镜像
docker load -i vllm-ascend-v0.22.1rc1.tar

# 验证镜像
docker images | grep vllm-ascend
```

### 步骤 4：准备模型文件

模型文件需要单独传输到服务器：

```bash
# 下载模型（需要网络环境）
# 通过 ModelScope 下载（推荐国内用户）
pip install -U modelscope
modelscope download --model Qwen/Qwen3-ASR-1.7B --local_dir ./Qwen3-ASR-1.7B

# 通过 Hugging Face 下载
huggingface-cli download Qwen/Qwen3-ASR-1.7B --local-dir ./Qwen3-ASR-1.7B

# 打包模型文件（约 3.4GB）
tar czf Qwen3-ASR-1.7B.tar.gz -C /path/to/models Qwen3-ASR-1.7B

# 传输到服务器
scp Qwen3-ASR-1.7B.tar.gz user@npu-server:/home/user/

# 在服务器上解压
mkdir -p /home/models
tar xzf Qwen3-ASR-1.7B.tar.gz -C /home/models/
```

### 步骤 5：启动服务

```bash
# 在服务器上进入部署目录
cd /path/to/MediaFlow/deploy/qwen3-asr-npu

# 修改 docker-compose.yml 中的 NPU 卡号
# 启动服务
docker-compose up -d
```

### 离线部署文件清单

需要传输的文件：

| 文件 | 大小 | 说明 |
|------|------|------|
| `vllm-ascend-v0.22.1rc1.tar` | ~8-10GB | Docker 镜像 |
| `Qwen3-ASR-1.7B.tar.gz` | ~3.4GB | 模型文件 |
| `docker-compose.yml` | <1KB | 部署配置 |

## 四、MediaFlow 配置

在 MediaFlow 页面「服务配置」中设置：

| 配置项 | 值 |
|--------|-----|
| 接口类型 | `openai_chat_audio` |
| 接口地址 | `http://<服务器IP>:8022/v1` |
| 模型名称 | `qwen3-asr`（由 `--served-model-name` 指定） |
| API 密钥 | （留空） |
| 识别语言 | `zh` |

## 五、流式部署（边说边出字）

上面的 `vllm serve` 部署提供 OpenAI 兼容接口，只能**收完整音频后返回**结果。
MediaFlow 端用 `realtime_offline`（录完再识别、结果逐字推送）模拟流式体验，
但并非真正的边说边出字。

如果需要**真正的流式识别**——音频 chunk 到达即解码、增量识别、立即推送部分
结果——请额外部署 `streaming_server`。它包装了 `qwen-asr` 库的
`streaming_transcribe()` 增量流式 API，对外暴露与 MediaFlow `realtime_http`
provider 兼容的 HTTP+SSE 协议。

### 5.1 两种部署的区别

| 维度 | vLLM 服务（qwen3-asr） | 流式服务（streaming） |
|------|------------------------|------------------------|
| 端口 | 8022 | 8023 |
| 接口 | OpenAI 兼容 `/v1/...` | HTTP+SSE `/session/...` |
| 识别方式 | 收完整音频后返回 | 边收边识别，逐块推送部分结果 |
| MediaFlow 接口类型 | `openai_chat_audio` + `realtime_offline` 模拟 | `realtime_http` 真流式 |
| NPU 占用 | 1 张卡 | 独占**另一张**卡 |

两个服务可以同时运行（各占一张 NPU 卡），也可以只部署其中一个。

### 5.2 部署流式服务

流式服务需要独占一张 NPU 卡，**不能与 vLLM 服务共用同一张卡**。
先用 `npu-smi info` 确认有空闲卡，然后编辑 `docker-compose.yml` 的 `streaming`
段，把卡号改成实际空闲卡：

```yaml
environment:
  - ASCEND_RT_VISIBLE_DEVICES=1   # 改为实际空闲卡号

devices:
  - /dev/davinci1:/dev/davinci1   # 数字需与上面一致
```

构建并启动（首次会构建镜像，安装 ffmpeg 与 qwen-asr，需要几分钟）：

```bash
# 只启动流式服务
docker-compose up -d --build streaming

# 或同时启动 vLLM 服务与流式服务
docker-compose up -d --build
```

查看日志，等待模型加载完成：

```bash
docker-compose logs -f streaming
```

看到 `model ready` 与 `Uvicorn running on http://0.0.0.0:8001` 即启动成功。

### 5.3 健康检查与测试

```bash
# 健康检查（model_loaded=true 表示模型已加载）
curl http://localhost:8023/health

# 创建会话
curl -X POST http://localhost:8023/session \
  -H "Content-Type: application/json" \
  -d '{"language": "zh", "format": "pcm_s16le", "sample_rate": 16000, "channels": 1}'
# → {"session_id": "..."}
```

拿到 `session_id` 后可用两个终端分别订阅 SSE、推送音频，验证逐块返回：

```bash
# 终端 A：订阅事件流（会持续输出 online/final/done 事件）
curl -N http://localhost:8023/session/<session_id>/events

# 终端 B：推送 base64 音频块（普通块 is_final=false，结束块 audio 为空 is_final=true）
curl -X POST http://localhost:8023/session/<session_id>/audio \
  -H "Content-Type: application/json" \
  -d '{"seq": 1, "audio": "<base64>", "format": "pcm_s16le", "is_final": false}'
```

### 5.4 MediaFlow 配置连接流式服务

在 MediaFlow 页面「服务配置 → 实时识别」中设置：

| 配置项 | 值 |
|--------|-----|
| 实时接口类型 | `realtime_http` |
| 实时接口地址 | `http://<服务器IP>:8023` |
| 实时接口密钥 | （留空） |
| 实时模型名称 | （留空，或填 `qwen3-asr`） |

保存后打开「实时识别」页面，用「浏览器录音测试」的「开始录音」对着麦克风说话，
即可看到文字**边说边出现**（而非录完才出现）。

> 说明：浏览器 MediaRecorder 产出的是 webm/ogg(opus) 容器增量流，流式服务内部
> 为每个会话维护一个常驻 ffmpeg 进程，把不断到达的字节解码为 16kHz 单声道 PCM
> 后喂给模型，因此镜像内需要 ffmpeg（Dockerfile 已包含）。

### 5.5 流式服务常用操作

```bash
# 查看日志
docker-compose logs -f streaming

# 重启
docker-compose restart streaming

# 停止
docker-compose stop streaming

# 重新构建（改了 server.py 后）
docker-compose up -d --build streaming
```

## 六、常用操作

```bash
# 查看日志
docker-compose logs -f

# 重启服务
docker-compose restart

# 停止服务
docker-compose down

# 重新启动
docker-compose down && docker-compose up -d

# 查看容器状态
docker ps | grep qwen3-asr

# 进入容器调试
docker exec -it qwen3-asr bash
```

## 六、切换 NPU 卡号

修改 `docker-compose.yml` 中的两个地方：

```yaml
environment:
  - ASCEND_RT_VISIBLE_DEVICES=1  # 改为新卡号

devices:
  - /dev/davinci1:/dev/davinci1  # 改为新卡号
```

然后重启服务：

```bash
docker-compose down && docker-compose up -d
```

## 七、故障排查

### 模型加载失败

```bash
# 检查模型文件是否完整
ls -la /home/models/Qwen3-ASR-1.7B/

# 检查容器内模型路径
docker exec -it qwen3-asr ls /data/models/Qwen3-ASR-1.7B/
```

### NPU 设备不可用

```bash
# 检查 NPU 状态
npu-smi info

# 检查容器内设备
docker exec -it qwen3-asr ls /dev/davinci*
```

### 端口被占用

```bash
# 查看 8022 端口占用
lsof -i:8022

# 修改 docker-compose.yml 中的端口映射
ports:
  - "8023:8000"  # 改为其他端口
```

### 版本兼容性问题

确保使用正确的版本组合：

| 组件 | 版本 |
|------|------|
| vllm-ascend | v0.22.1 |
| CANN | 9.0.1 |
| PyTorch | 2.10.0 |
| torch-npu | 2.10.0.post2 |

## 八、参考文档

- [vllm-ascend 官方文档](https://docs.vllm.ai/projects/ascend/en/latest/)
- [Qwen3-ASR-1.7B 部署指南](https://docs.vllm.ai/projects/ascend/en/latest/tutorials/models/Qwen3-ASR-1.7B.html)
- [Qwen3-ASR GitHub](https://github.com/QwenLM/Qwen3-ASR)
- [Qwen3-ASR PyPI](https://pypi.org/project/qwen-asr/)
