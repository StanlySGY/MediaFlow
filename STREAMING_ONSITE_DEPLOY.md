# Qwen3-ASR-Streaming 离线现场部署手册

> 仅部署 **流式边说边出字** 服务（端口 8023）。
> 前提：现场已具备 `vllm-ascend:v0.22.1rc1` 基础镜像（已 load 进 Docker）、Ascend NPU 驱动、Docker、Docker Compose。
> 离线现场无需联网。所有命令按顺序复制执行。

---

## 〇、带去现场的东西

| 文件                           | 大小 | 用途                                  |
| ------------------------------ | ---- | ------------------------------------- |
| `streaming-part-aa`          | 3.8G | streaming 镜像分片 1                  |
| `streaming-part-ab`          | 3.4G | streaming 镜像分片 2                  |
| `streaming-checksum.txt`     | <1K  | 分片校验和                            |
| `deploy/qwen3-asr-npu/` 目录 | 52K  | docker-compose.yml + streaming_server |
| MediaFlow 项目代码             | —   | 含最新 docker-compose.yml 等          |

> 刻盘：盘 1 装 `streaming-part-aa` + 校验文件，盘 2 装 `streaming-part-ab`。
> 也可用 U 盘/移动硬盘直接拷，省得刻盘。

---

## 一、合并并导入 streaming 镜像

### 1.1 把两个分片拷到同一目录

```bash
mkdir -p /home/deploy && cd /home/deploy

# 把分片都拷到这里，最终应有：
# streaming-part-aa
# streaming-part-ab
# streaming-checksum.txt
```

### 1.2 校验分片完整性（强烈建议）

```bash
cd /home/deploy
sha256sum -c streaming-checksum.txt
# 必须全部输出 OK，有失败就重新拷那一片
```

### 1.3 合并 + 导入镜像

```bash
cd /home/deploy

# 合并还原 tar.gz
cat streaming-part-* > streaming-update-v2.tar.gz

# 导入 Docker（会显示 Loaded image: qwen3-asr-npu-streaming:latest）
docker load -i streaming-update-v2.tar.gz

# 确认镜像已导入
docker images | grep qwen3-asr-npu-streaming
# 应看到 qwen3-asr-npu-streaming    latest    ...    21.3GB
```

---

## 二、准备部署目录

### 2.1 放置 deploy 目录

把 `deploy/qwen3-asr-npu/` 整个目录拷到服务器，例如：

```bash
# 最终结构
# /home/deploy/qwen3-asr-npu/docker-compose.yml
# /home/deploy/qwen3-asr-npu/streaming_server/Dockerfile
# /home/deploy/qwen3-asr-npu/streaming_server/server.py
```

### 2.2 用专用 compose 文件启动（推荐）

项目里已提供只启动 streaming 的 compose 文件 `docker-compose.streaming.yml`，无需改原 `docker-compose.yml`。只需改这一个文件的两处：

编辑 `/home/deploy/qwen3-asr-npu/docker-compose.streaming.yml`：

```yaml
  streaming:
    environment:
      - ASCEND_RT_VISIBLE_DEVICES=1      # ← 改为实际空闲卡号（npu-smi info 查看）
    devices:
      - /dev/davinci1:/dev/davinci1      # ← 数字与上面一致
```

若模型不在 `/home/models/Qwen3-ASR-1.7B`，改 volumes 左侧宿主机路径。

> 这个 compose 文件已用 `image: qwen3-asr-npu-streaming`（不是 `build:`），现场无网也能直接起，不会试图联网构建。

### 2.3 （备选）改原 docker-compose.yml

若用原来的 `docker-compose.yml`：找到 `streaming` 服务段，**把 `build:` 换成 `image:`**：

```yaml
  streaming:
    image: qwen3-asr-npu-streaming      # ← 用这一行（替换原来的 build:）
    # 删掉下面这两行：
    # build: ./streaming_server
```

---

## 三、检查 NPU 并分配卡号

### 3.1 查看 NPU 卡

```bash
npu-smi info
```

记下空闲的卡号。streaming 服务需要**独占一张卡**，不能和 vLLM 文件识别服务（qwen3-asr，用卡 0）共用。

### 3.2 修改 streaming 服务的 NPU 卡号

编辑 `/home/deploy/qwen3-asr-npu/docker-compose.yml` 的 `streaming` 段：

```yaml
  streaming:
    environment:
      - ASCEND_RT_VISIBLE_DEVICES=1      # ← 改成实际空闲卡号（不要和 qwen3-asr 重复）
    devices:
      - /dev/davinci1:/dev/davinci1      # ← 数字与上面一致
      - /dev/davinci_manager:/dev/davinci_manager
      - /dev/devmm_svm:/dev/devmm_svm
      - /dev/hisi_hdc:/dev/hisi_hdc
```

### 3.3 确认模型路径

`docker-compose.yml` 里 streaming 的 volume 写死:

```yaml
- /home/models/Qwen3-ASR-1.7B:/data/models/Qwen3-ASR-1.7B
```

若模型在别处，改左侧宿主机路径。确认模型文件在：

```bash
ls /home/models/Qwen3-ASR-1.7B/
# 应有 config.json、*.safetensors 等
```

---

## 四、启动 streaming 服务

### 4.1 启动（不 build，直接用已 load 的镜像）

```bash
cd /home/deploy/qwen3-asr-npu

# 只启动 streaming 服务（不会联网构建，用已 load 的镜像）
docker compose -f docker-compose.streaming.yml up -d streaming
```

> 用专用 compose 文件 `docker-compose.streaming.yml`（推荐），里面已配好 `image:`，不会触发构建。
> 若用原 `docker-compose.yml`，确认 streaming 段已改成 `image:`，然后 `docker compose up -d streaming`。

### 4.2 看日志等就绪

```bash
docker compose -f docker-compose.streaming.yml logs -f
```

等到看到这两行说明启动成功：

```
... model ready ...
INFO:     Uvicorn running on http://0.0.0.0:8001
```

`Ctrl+C` 退出日志（不会停服务）。

### 4.3 验证服务

```bash
# 健康检查（model_loaded=true 即正常）
curl http://localhost:8023/health

# 创建测试会话
curl -X POST http://localhost:8023/session \
  -H "Content-Type: application/json" \
  -d '{"language": "zh", "format": "pcm_s16le", "sample_rate": 16000, "channels": 1}'
# → {"session_id": "..."}
```

返回有 session_id 说明 streaming 服务完全正常。

---

## 五、配置 MediaFlow 连接 streaming

### 5.1 编辑 MediaFlow 的 .env

```bash
cd /path/to/MediaFlow
vi .env
```

确保实时识别配置指向 streaming 服务:

```ini
# 实时识别（边说边出字）
REALTIME_ASR_PROVIDER=realtime_http
REALTIME_ASR_BASE_URL=http://localhost:8023
REALTIME_ASR_API_KEY=
REALTIME_ASR_MODEL=qwen3-asr
```

> MediaFlow 和 streaming 同机用 `localhost`；不同机换成 streaming 服务器 IP。

### 5.2 重启 MediaFlow

```bash
docker compose -f docker-compose.prod.yml restart
# 或先 down 再 up
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

---

## 六、浏览器测试边说边出字

打开 `http://<服务器IP>:8999/` → 进「实时识别」页面 → 服务配置核对:

| 配置项       | 值                         |
| ------------ | -------------------------- |
| 实时接口类型 | `realtime_http`          |
| 实时接口地址 | `http://<服务器IP>:8023` |
| 实时接口密钥 | （留空）                   |
| 实时模型名称 | `qwen3-asr`              |

保存 → 顶部「浏览器录音测试」→ 点「开始录音」→ 对麦克风说话 → **文字边说边出现** → 点「停止录音」结束。

---

## 七、一页速查（清单式）

```bash
# 1. 合并导入 streaming 镜像（分片已拷到 /home/deploy/）
cd /home/deploy
sha256sum -c streaming-checksum.txt                    # 校验
cat streaming-part-* > streaming-update-v2.tar.gz      # 合并
docker load -i streaming-update-v2.tar.gz              # 导入
docker images | grep qwen3-asr-npu-streaming           # 确认

# 2. 改专用 compose 文件的 NPU 卡号
npu-smi info
vi /home/deploy/qwen3-asr-npu/docker-compose.streaming.yml
#   environment: ASCEND_RT_VISIBLE_DEVICES=<空闲卡号>
#   devices: /dev/davinci<卡号>:/dev/davinci<卡号>

# 3. 启动 streaming（用专用 compose 文件，不联网构建）
cd /home/deploy/qwen3-asr-npu
docker compose -f docker-compose.streaming.yml up -d
docker compose -f docker-compose.streaming.yml logs -f   # 等 "model ready"

# 4. 验证
curl http://localhost:8023/health

# 5. 配置 MediaFlow 并重启
cd /path/to/MediaFlow
vi .env                 # REALTIME_ASR_BASE_URL=http://localhost:8023
docker compose -f docker-compose.prod.yml restart

# 6. 浏览器 http://<服务器IP>:8999/ → 实时识别 → 开始录音
```

---

## 八、故障排查

### 8.1 分片校验失败

```bash
sha256sum -c streaming-checksum.txt
# 有失败的，重新拷那一片（U盘/盘可能拷坏）
```

### 8.2 docker load 报错 "image not found" / 镜像名不一致

确认导入的镜像名和 docker-compose.yml 里 `image:` 一致:

```bash
docker images | grep streaming
# 应是 qwen3-asr-npu-streaming:latest
# docker-compose.yml 里 image: 也必须是 qwen3-asr-npu-streaming
```

### 8.3 启动时报 "failed to build" / 试图联网

说明用的 compose 文件还在用 `build:`（原 `docker-compose.yml`）。应改用专用文件：

```bash
docker compose -f docker-compose.streaming.yml up -d
# 该文件已用 image: qwen3-asr-npu-streaming，不会触发构建
```

若一定要用原 `docker-compose.yml`，确认 streaming 段已改成 `image:`（无 `build:`）。

### 8.4 NPU 设备不可用

```bash
npu-smi info                              # 宿主机能否看到卡
docker exec -it qwen3-asr-streaming ls /dev/davinci*  # 容器内能否看到
# 看不到 → 检查 devices 段卡号、是否和 qwen3-asr 服务重复占用
```

### 8.5 模型加载失败

```bash
ls -la /home/models/Qwen3-ASR-1.7B/      # 模型文件是否齐全
docker exec -it qwen3-asr-streaming ls /data/models/Qwen3-ASR-1.7B/  # 容器内挂载
# 挂载路径不对 → 改 docker-compose.streaming.yml volumes 左侧
```

### 8.6 端口 8023 被占用

```bash
lsof -i:8023
# 改 docker-compose.streaming.yml ports 映射到空闲端口，同时改 MediaFlow 的 REALTIME_ASR_BASE_URL
```

### 8.7 MediaFlow 实时识别报 503 / "missing http protocol"

- 503 = streaming 服务没起来，`docker compose -f docker-compose.streaming.yml logs` 看
- "missing http protocol" = 旧版 MediaFlow bug，确认跑的是 1.4.1+ 镜像

---

## 九、运维命令

```bash
cd /home/deploy/qwen3-asr-npu

# 用专用 compose 文件操作
docker compose -f docker-compose.streaming.yml logs -f        # 看日志
docker compose -f docker-compose.streaming.yml restart        # 重启
docker compose -f docker-compose.streaming.yml down           # 停止
docker compose -f docker-compose.streaming.yml up -d          # 启动

docker ps | grep streaming                # 看容器状态
npu-smi info                             # 看 NPU 占用
```
