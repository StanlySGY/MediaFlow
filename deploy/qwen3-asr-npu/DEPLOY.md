# Qwen3-ASR-1.7B NPU 部署文档

## 一、环境要求

- 华为昇腾 NPU（Atlas 800I A2 等）
- Docker + Docker Compose
- NPU 驱动已安装（`npu-smi info` 可正常执行）

## 二、在线部署（服务器可联网）

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

### 5. 构建并启动服务

```bash
# 构建镜像（首次需要，后续直接启动）
docker-compose build

# 启动服务
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
INFO:     Uvicorn running on http://0.0.0.0:8022
```

### 7. 测试接口

```bash
# 查看模型列表
curl http://localhost:8022/v1/models

# 测试音频识别（需要有音频文件）
curl http://localhost:8022/v1/audio/transcriptions \
  -F "file=@test.wav"
```

## 三、离线部署（服务器无网络）

适用于 NPU 服务器无法联网的场景。需要在本地有网络的机器上构建镜像，然后传输到服务器。

### 步骤 1：在本地机器构建镜像

```bash
# 克隆代码
git clone https://github.com/StanlySGY/MediaFlow.git
cd MediaFlow/deploy/qwen3-asr-npu

# 构建镜像
docker build -t qwen3-asr-npu:latest .

# 导出镜像为 tar 文件（约 8-10GB）
docker save qwen3-asr-npu:latest -o qwen3-asr-npu.tar
```

### 步骤 2：传输到 NPU 服务器

```bash
# 方式一：SCP 传输
scp qwen3-asr-npu.tar user@npu-server:/home/user/

# 方式二：USB 拷贝
# 将 qwen3-asr-npu.tar 拷贝到 USB 盘，插入服务器后复制
```

### 步骤 3：在 NPU 服务器导入镜像

```bash
# 导入镜像
docker load -i qwen3-asr-npu.tar

# 验证镜像
docker images | grep qwen3-asr-npu
```

### 步骤 4：准备模型文件

模型文件需要单独传输到服务器：

```bash
# 模型文件约 3.4GB，打包传输
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
| `qwen3-asr-npu.tar` | ~8-10GB | Docker 镜像 |
| `Qwen3-ASR-1.7B.tar.gz` | ~3.4GB | 模型文件 |
| `docker-compose.yml` | <1KB | 部署配置 |

## 四、MediaFlow 配置

在 MediaFlow 页面「服务配置」中设置：

| 配置项 | 值 |
|--------|-----|
| 接口类型 | `openai_compat` |
| 接口地址 | `http://<服务器IP>:8022/v1` |
| 模型名称 | `qwen3-asr-1.7b` |
| API 密钥 | （留空） |
| 识别语言 | `zh` |

## 五、常用操作

```bash
# 查看日志
docker-compose logs -f

# 重启服务
docker-compose restart

# 停止服务
docker-compose down

# 重新构建并启动
docker-compose down && docker-compose build && docker-compose up -d

# 查看容器状态
docker ps | grep qwen3-asr
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
docker exec -it qwen3-asr ls /app/models/Qwen3-ASR-1.7B/
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
  - "8023:8022"  # 改为其他端口
```
