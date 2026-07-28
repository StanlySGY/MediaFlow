# Qwen3-ASR 离线 NPU 部署文档

## 一、环境要求

### 硬件

| 组件 | 要求 |
|------|------|
| NPU | 华为昇腾 910B 或 310P |
| 显存 | 910B: 64GB / 310P: 48GB |
| 内存 | 建议 64GB+ |
| 磁盘 | 模型文件约 3.4GB，镜像约 4-5GB |

### 软件

- 麒麟 OS（或其他支持昇腾 NPU 的 Linux）
- Docker + Docker Compose
- NPU 驱动已安装（`npu-smi info` 可正常执行）
- CANN 9.0.1

## 二、需要准备的文件

| 文件 | 大小 | 说明 |
|------|------|------|
| `vllm-ascend-v0.22.1rc1.tar.gz` | ~4-5GB | Docker 镜像（含 vLLM + 运行环境） |
| `docker-compose.yml` | <1KB | 部署配置 |
| 模型文件 | ~3.4GB | Qwen3-ASR-1.7B（现场已有则不需要） |

## 三、文件准备（在有网络的机器上执行）

### 1. 下载 Docker 镜像并导出

```bash
# 拉取镜像
docker pull quay.io/ascend/vllm-ascend:v0.22.1rc1

# 导出为 tar.gz
docker save quay.io/ascend/vllm-ascend:v0.22.1rc1 | gzip > vllm-ascend-v0.22.1rc1.tar.gz
```

### 2. 下载模型文件（现场没有时才需要）

```bash
# 安装 modelscope
pip install -U modelscope

# 下载模型
modelscope download --model Qwen/Qwen3-ASR-1.7B --local_dir ./Qwen3-ASR-1.7B

# 打包
tar czf Qwen3-ASR-1.7B.tar.gz ./Qwen3-ASR-1.7B
```

### 3. 准备 docker-compose.yml

从 MediaFlow 项目中拷贝：

```bash
cp /path/to/MediaFlow/deploy/qwen3-asr-npu/docker-compose.yml ./
```

## 四、传输文件到现场

```bash
# 方式一：U 盘拷贝
cp vllm-ascend-v0.22.1rc1.tar.gz docker-compose.yml /media/usb/

# 方式二：SCP 传输
scp vllm-ascend-v0.22.1rc1.tar.gz docker-compose.yml user@npu-server:/home/user/
```

## 五、现场部署

### 步骤 1：导入镜像

```bash
gunzip -c vllm-ascend-v0.22.1rc1.tar.gz | docker load
```

### 步骤 2：准备模型文件（现场没有时才需要）

```bash
mkdir -p /home/models
tar xzf Qwen3-ASR-1.7B.tar.gz -C /home/models/
```

### 步骤 3：检查 NPU 状态

```bash
npu-smi info
```

记下空闲的 NPU 卡号（0、1、2...）。

### 步骤 4：修改配置

编辑 `docker-compose.yml`，修改 NPU 卡号（如果需要）：

```yaml
environment:
  - ASCEND_RT_VISIBLE_DEVICES=0  # 改为实际卡号

devices:
  - /dev/davinci0:/dev/davinci0  # 改为实际卡号
```

修改模型路径（如果模型不在 `/home/models/Qwen3-ASR-1.7B`）：

```yaml
volumes:
  - /你的模型路径/Qwen3-ASR-1.7B:/data/models/Qwen3-ASR-1.7B
```

### 步骤 5：启动服务

```bash
cd /path/to/docker-compose.yml所在目录
docker-compose up -d
```

### 步骤 6：查看日志

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

### 步骤 7：验证服务

```bash
# 查看模型列表
curl http://localhost:8022/v1/models

# 测试识别（使用测试音频）
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
```

## 六、MediaFlow 配置

在 MediaFlow 页面「服务配置」中设置：

| 配置项 | 值 |
|--------|-----|
| 接口类型 | `openai_chat_audio` |
| 接口地址 | `http://<服务器IP>:8022/v1` |
| 模型名称 | `qwen3-asr`（由 `--served-model-name` 指定） |
| API 密钥 | （留空） |
| 识别语言 | `zh` |

## 七、常用操作

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

## 八、切换 NPU 卡号

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

## 九、故障排查

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

## 十、参考文档

- [vllm-ascend 官方文档](https://docs.vllm.ai/projects/ascend/en/latest/)
- [Qwen3-ASR-1.7B 部署指南](https://docs.vllm.ai/projects/ascend/en/latest/tutorials/models/Qwen3-ASR-1.7B.html)
- [Qwen3-ASR GitHub](https://github.com/QwenLM/Qwen3-ASR)
