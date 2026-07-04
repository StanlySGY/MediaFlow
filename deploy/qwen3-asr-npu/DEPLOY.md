# Qwen3-ASR-1.7B 部署文档

## 一、环境要求

- 华为昇腾 NPU（Atlas 800I A2 等）
- Docker 已安装
- NPU 驱动已安装（`npu-smi info` 可正常执行）

## 二、文件清单

| 文件 | 说明 |
|------|------|
| `qwen3-asr-1.0.0-aarch64.tar.gz` | Docker 镜像 |
| `DEPLOY.md` | 本文档 |

模型文件 `/home/models/Qwen3-ASR-1.7B/` 已在服务器上，无需额外拷贝。

## 三、部署步骤

### 1. 加载镜像

```bash
docker load -i qwen3-asr-1.0.0-aarch64.tar.gz
```

### 2. 停止旧容器（如有）

```bash
docker rm -f qwen3-asr-1.7b 2>/dev/null
```

### 3. 查看 NPU 卡号

```bash
npu-smi info
```

选择一张空闲的卡，记下卡号（0、1、2...）。

### 4. 启动容器

将下面命令中的 `2` 替换为实际的卡号：

```bash
docker run -dit \
--name qwen3-asr \
--shm-size=1g \
--device /dev/davinci2 \
--device /dev/davinci_manager \
--device /dev/devmm_svm \
--device /dev/hisi_hdc \
-v /usr/local/dcmi:/usr/local/dcmi \
-v /usr/local/bin/npu-smi:/usr/local/bin/npu-smi \
-v /usr/local/Ascend/driver/lib64/:/usr/local/Ascend/driver/lib64/ \
-v /usr/local/Ascend/driver/version.info:/usr/local/Ascend/driver/version \
-v /etc/ascend_install.info:/etc/ascend_install.info \
-v /home/models/Qwen3-ASR-1.7B:/app/models/Qwen3-ASR-1.7B \
-p 8022:8022 \
-e ASCEND_RT_VISIBLE_DEVICES=2 \
qwen3-asr:1.0.0
```

> 注意：`--device /dev/davinci2` 和 `ASCEND_RT_VISIBLE_DEVICES=2` 中的数字要一致，且与 `npu-smi info` 中的卡号一致。

### 5. 查看日志

```bash
docker logs -f qwen3-asr
```

看到以下内容说明启动成功：

```
Loading model from /app/models/Qwen3-ASR-1.7B...
Model ready
Start uvicorn 0.0.0.0:8022
```

### 6. 测试接口

```bash
# 查看模型列表
curl http://localhost:8022/v1/models

# 测试音频识别（需要有音频文件）
curl http://localhost:8022/v1/audio/transcriptions \
  -F "file=@test.wav"
```

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
docker logs -f qwen3-asr

# 重启容器
docker restart qwen3-asr

# 停止容器
docker stop qwen3-asr

# 删除容器
docker rm -f qwen3-asr

# 查看容器状态
docker ps | grep qwen3-asr
```

## 六、切换 NPU 卡号

如需切换到其他卡，先停止并删除旧容器，再用新卡号启动：

```bash
# 停止并删除
docker rm -f qwen3-asr

# 用第 0 号卡启动
docker run -dit \
--name qwen3-asr \
--shm-size=1g \
--device /dev/davinci0 \
--device /dev/davinci_manager \
--device /dev/devmm_svm \
--device /dev/hisi_hdc \
-v /usr/local/dcmi:/usr/local/dcmi \
-v /usr/local/bin/npu-smi:/usr/local/bin/npu-smi \
-v /usr/local/Ascend/driver/lib64/:/usr/local/Ascend/driver/lib64/ \
-v /usr/local/Ascend/driver/version.info:/usr/local/Ascend/driver/version \
-v /etc/ascend_install.info:/etc/ascend_install.info \
-v /home/models/Qwen3-ASR-1.7B:/app/models/Qwen3-ASR-1.7B \
-p 8022:8022 \
-e ASCEND_RT_VISIBLE_DEVICES=0 \
qwen3-asr:1.0.0
```
