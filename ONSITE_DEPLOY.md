# MediaFlow + Qwen3-ASR 离线现场部署手册

> 现场无网络，所有命令按顺序复制执行即可。
> 前提：现场服务器已安装 Ascend NPU 驱动（`npu-smi info` 能执行）、Docker、Docker Compose。
>
> **架构说明**：本流程的目标服务器是 **ARM（鲲鹏 920）**。所有 Docker 镜像必须用 **ARM 架构** 构建/拉取。
> - 开发机 WSL2 是 x86，**不要**在 WSL2 上构建带去现场的镜像。
> - 必须在与现场同架构的 **ARM 打包服务器**上构建、导出，再刻盘带去现场。

---

## 〇、你带去现场的东西

| 文件 | 大小 | 用途 |
|------|------|------|
| `vllm-part-aa` + `vllm-part-ab` + `vllm-checksum.txt` | ~6.5G | ASR 推理镜像（两片分卷，刻在两张 4G 盘上） |
| `streaming.tar.gz` | ~? | 流式服务镜像（本地预构建，现场无需联网构建） |
| `mediaflow-1.7.0-arm64.tar.gz` | ~? | MediaFlow 应用镜像（`./build.sh --save` 生成） |
| `Qwen3-ASR-1.7B.tar.gz` | ~3.4G | 模型文件（现场已有模型则不用带） |
| `deploy/qwen3-asr-npu/` 目录 | 52K | ASR 服务的 docker-compose.yml + streaming_server |
| MediaFlow 项目代码 | — | `docker-compose.prod.yml`、`.env.example` 等 |

> 如果 MediaFlow 镜像也超过 4G，用同样的 `split -n 2` 方法切两片。

---

## 一、合并并导入 ASR 镜像

### 1.1 把两张盘的分片拷到同一个目录

```bash
mkdir -p /home/deploy && cd /home/deploy

# 把盘 1 / 盘 2 里的分片都拷到这里，最终应有：
# vllm-part-aa
# vllm-part-ab
# vllm-checksum.txt
```

### 1.2 校验分片完整性（强烈建议）

```bash
cd /home/deploy
sha256sum -c vllm-checksum.txt
# 输出必须全部是 OK，有任意一个失败就重新拷盘
```

### 1.3 合并 + 导入镜像

```bash
cd /home/deploy

# 合并还原 tar.gz
cat vllm-part-* > vllm-ascend-v0.22.1rc1.tar.gz

# 导入 Docker（会显示 Loaded image: ...）
gunzip -c vllm-ascend-v0.22.1rc1.tar.gz | docker load

# 确认镜像已导入
docker images | grep vllm-ascend
# 应看到 quay.io/ascend/vllm-ascend    v0.22.1rc1
```

---

## 二、导入 MediaFlow 应用镜像

### 2.1 如果 MediaFlow 镜像是整包

```bash
docker load -i mediaflow-1.7.0-arm64.tar.gz
docker images | grep mediaflow
# 应看到 mediaflow    1.7.0
```

### 2.2 如果 MediaFlow 镜像也分片了

```bash
sha256sum -c mediaflow-checksum.txt        # 校验
cat mediaflow-part-* > mediaflow-1.7.0-arm64.tar.gz
docker load -i mediaflow-1.7.0-arm64.tar.gz
```

---

## 三、准备模型文件

> 现场如果已有 `/home/models/Qwen3-ASR-1.7B/` 目录，跳过此步。

```bash
mkdir -p /home/models
tar xzf Qwen3-ASR-1.7B.tar.gz -C /home/models/

# 确认模型文件齐全
ls /home/models/Qwen3-ASR-1.7B/
# 应看到 config.json、模型权重 *.safetensors 等
```

---

## 四、检查 NPU 并分配卡号

### 4.1 查看所有 NPU 卡

```bash
npu-smi info
```

记下空闲的卡号。**要同时跑「文件识别」+「流式边说边出字」需要两张卡**：
- vLLM 文件识别服务用一张（示例用卡 0）
- streaming 流式服务用另一张（示例用卡 1）

> 只想跑其中一个，单张卡即可。

### 4.2 把部署目录放到服务器

```bash
# 把 deploy/qwen3-asr-npu 整个目录拷到 /home/deploy/
# 最终结构：
# /home/deploy/qwen3-asr-npu/docker-compose.yml
# /home/deploy/qwen3-asr-npu/streaming_server/Dockerfile
# /home/deploy/qwen3-asr-npu/streaming_server/server.py
```

### 4.3 修改 NPU 卡号（按实际空闲卡改）

编辑 `/home/deploy/qwen3-asr-npu/docker-compose.yml`：

**vLLM 文件识别服务（默认卡 0）：**
```yaml
  qwen3-asr:
    environment:
      - ASCEND_RT_VISIBLE_DEVICES=0      # ← 改成实际卡号
    devices:
      - /dev/davinci0:/dev/davinci0      # ← 数字与上面一致
      - /dev/davinci_manager:/dev/davinci_manager
      - /dev/devmm_svm:/dev/devmm_svm
      - /dev/hisi_hdc:/dev/hisi_hdc
```

**streaming 流式服务（默认卡 1）：**
```yaml
  streaming:
    environment:
      - ASCEND_RT_VISIBLE_DEVICES=1       # ← 改成另一张实际卡号
    devices:
      - /dev/davinci1:/dev/davinci1      # ← 数字与上面一致
      - /dev/davinci_manager:/dev/davinci_manager
      - /dev/devmm_svm:/dev/devmm_svm
      - /dev/hisi_hdc:/dev/hisi_hdc
```

### 4.4 确认模型路径

`docker-compose.yml` 里两个服务的 volumes 都写死了：
```yaml
- /home/models/Qwen3-ASR-1.7B:/data/models/Qwen3-ASR-1.7B
```
若模型放在别处，把左边宿主机路径改成实际路径。

---

## 五、启动 ASR 服务

### 5.1 构建 + 启动

> streaming 服务现查镜像不在本地，首次会构建（装 ffmpeg + qwen-asr，**需要几分钟，期间需联网装依赖**）。
> ⚠️ **现场离线**：streaming 的 Dockerfile 用 `pip install qwen-asr fastapi uvicorn numpy` 和 `apt-get install ffmpeg`，需要联网。如果现场无网，需要事先在有网机器上把 streaming 镜像也 build 好导出。

```bash
cd /home/deploy/qwen3-asr-npu

# 同时启动文件识别 + 流式服务（首次构建 streaming 镜像）
docker-compose up -d --build

# 或者只启动某一个：
docker-compose up -d qwen3-asr          # 只起文件识别
docker-compose up -d --build streaming   # 只起流式
```

### 5.2 看日志等就绪

```bash
# 文件识别服务（等到 "Uvicorn running on http://0.0.0.0:8000"）
docker-compose logs -f qwen3-asr

# 流式服务（等到 "model ready" + "Uvicorn running on http://0.0.0.0:8001"）
docker-compose logs -f streaming
```

看到上述字样说明启动成功，`Ctrl+C` 退出日志（不会停服务）。

### 5.3 验证 ASR 服务

```bash
# 文件识别：查看模型列表
curl http://localhost:8022/v1/models
# 应返回包含 "qwen3-asr" 的 JSON

# 流式服务：健康检查
curl http://localhost:8023/health
# 应返回 {"model_loaded": true, ...}
```

两个都正常，ASR 部分搞定。

---

## 六、启动 MediaFlow 应用

### 6.1 放置 MediaFlow 项目代码

把 MediaFlow 项目目录拷到服务器（例如 `/home/deploy/MediaFlow`），至少需要：
- `docker-compose.prod.yml`
- `.env.example`
- `app/`（builder 镜像里已打包，prod 模式跑预加载镜像不需要源码，但留着无害）

### 6.2 创建并编辑 .env

```bash
cd /home/deploy/MediaFlow
cp .env.example .env
```

编辑 `.env`，关键几项：

```ini
# 主 ASR 接口（指向本地 vLLM 文件识别服务）
ASR_PROVIDER=openai_chat_audio
ASR_BASE_URL=http://localhost:8022/v1
ASR_API_KEY=
ASR_MODEL=qwen3-asr
ASR_LANGUAGE=zh
ASR_TIMESTAMPS=true

# 实时识别（指向本地流式服务，边说边出字）
REALTIME_ASR_PROVIDER=realtime_http
REALTIME_ASR_BASE_URL=http://localhost:8023
REALTIME_ASR_API_KEY=
REALTIME_ASR_MODEL=qwen3-asr

# 访问控制（现场内网可留空 = 不鉴权；要鉴权就填一个令牌）
# ACCESS_TOKENS=my-secret-token
```

> ⚠️ ASR 服务和 MediaFlow 都在同一台机器时，地址用 `localhost` 即可；
> 如果 MediaFlow 部署在另一台，地址换成 ASR 服务器 IP。

### 6.3 启动 MediaFlow

```bash
cd /home/deploy/MediaFlow
docker compose -f docker-compose.prod.yml up -d
```

### 6.4 确认运行

```bash
docker compose -f docker-compose.prod.yml ps
# mediaflow 状态 Up

curl http://localhost:8999/health
# 应返回健康状态
```

浏览器打开 `http://<服务器IP>:8999/`。

---

## 七、浏览器里完成配置

打开页面后进「服务配置」，**核对/修改以下两组**（与 .env 里的值一致，页面上改也行）：

### 7.1 语音识别接口（文件转写用）

| 配置项 | 值 |
|--------|-----|
| 接口类型 | `openai_chat_audio` |
| 接口地址 | `http://localhost:8022/v1` |
| API 密钥 | （留空） |
| 模型名称 | `qwen3-asr` |
| 识别语言 | `zh` |

点「测试连接」，显示「在线」即可。

### 7.2 实时识别（边说边出字）

| 配置项 | 值 |
|--------|-----|
| 实时接口类型 | `realtime_http` |
| 实时接口地址 | `http://localhost:8023` |
| 实时接口密钥 | （留空） |
| 实时模型名称 | `qwen3-asr` |

保存。

### 7.3 测试边说边出字

进「实时识别」页面 → 顶部「浏览器录音测试」→ 点「开始录音」→ 对麦克风说话 → 文字会**边说边出现**在白屏上 → 点「停止录音」结束。

---

## 八、常用运维命令

```bash
# === ASR 服务（在 /home/deploy/qwen3-asr-npu/）===
docker-compose logs -f qwen3-asr          # 看文件识别日志
docker-compose logs -f streaming          # 看流式日志
docker-compose restart                    # 重启
docker-compose down                       # 停止

# === MediaFlow（在 /home/deploy/MediaFlow/）===
docker compose -f docker-compose.prod.yml logs -f mediaflow
docker compose -f docker-compose.prod.yml restart
docker compose -f docker-compose.prod.yml down

# === 通用 ===
docker ps                                  # 看所有运行容器
npu-smi info                               # 看 NPU 占用
```

---

## 九、故障排查

### 9.1 镜像导入失败 / 分片校验不过

```bash
# 重新校验
sha256sum -c vllm-checksum.txt
# 有失败的，重新拷那一片
```

### 9.2 streaming 服务构建失败（离线装不了依赖）

**根因**：streaming 的 Dockerfile 要联网 `pip install` / `apt-get`，现场无网会失败。

**解法**：在有网机器上预先 build 好 streaming 镜像并导出，现场只 load：

```bash
# —— 有网机器上 ——
cd deploy/qwen3-asr-npu
docker-compose build streaming
docker save qwen3-asr-npu-streaming | gzip > streaming.tar.gz
# 把 streaming.tar.gz 拷去现场

# —— 现场无网 ——
docker load -i streaming.tar.gz
# 然后启动时不再 build：
docker-compose up -d streaming      # 已有镜像，直接起
```

> 若用此法，改 `docker-compose.yml` 把 `build: ./streaming_server` 换成 `image: qwen3-asr-npu-streaming`。

### 9.3 NPU 设备不可用

```bash
npu-smi info                              # 宿主机能否看到卡
docker exec -it qwen3-asr ls /dev/davinci*  # 容器内能否看到
# 看不到 → 检查 docker-compose.yml devices 段的卡号是否正确
```

### 9.4 模型加载失败

```bash
ls -la /home/models/Qwen3-ASR-1.7B/      # 模型文件是否齐全
docker exec -it qwen3-asr ls /data/models/Qwen3-ASR-1.7B/  # 容器内是否挂载上
# 挂载路径不对 → 改 docker-compose.yml 的 volumes 左侧路径
```

### 9.5 端口被占用

```bash
lsof -i:8022   # 文件识别端口
lsof -i:8023   # 流式端口
lsof -i:8999   # MediaFlow 端口
# 改 docker-compose.yml 的 ports 映射到空闲端口
```

### 9.6 鉴权问题（401）

「实时识别」开始录音报 401，是因为启用了 `ACCESS_TOKENS` 但页面没填令牌：
- 页面右上角点「令牌」输入你设的令牌；或
- `.env` 里 `ACCESS_TOKENS=` 留空（不鉴权）。

### 9.7 实时识别报 "missing http protocol"

这已修复（v1.4.1）。确认跑的是 1.4.1 或更高的镜像：
```bash
docker images | grep mediaflow
# 必须 ≥ 1.4.1。旧镜像就重新 load 新的。
```

---

## 十、一页速查（清单式）

```bash
# 1. 合并导入 ASR 镜像
cd /home/deploy
sha256sum -c vllm-checksum.txt
cat vllm-part-* > vllm-ascend-v0.22.1rc1.tar.gz
gunzip -c vllm-ascend-v0.22.1rc1.tar.gz | docker load

# 2. 导入 MediaFlow 镜像
docker load -i mediaflow-1.7.0-arm64.tar.gz

# 3. 放模型
mkdir -p /home/models && tar xzf Qwen3-ASR-1.7B.tar.gz -C /home/models/

# 4. 选 NPU 卡并改 docker-compose.yml
npu-smi info
vi /home/deploy/qwen3-asr-npu/docker-compose.yml   # 改卡号

# 5. 起 ASR 服务
cd /home/deploy/qwen3-asr-npu
docker-compose up -d --build
docker-compose logs -f streaming    # 等 "model ready"

# 6. 验证 ASR
curl http://localhost:8022/v1/models
curl http://localhost:8023/health

# 7. 起 MediaFlow
cd /home/deploy/MediaFlow
cp .env.example .env && vi .env      # 填 ASR / REALTIME 地址
docker compose -f docker-compose.prod.yml up -d
curl http://localhost:8999/health

# 8. 浏览器 http://<服务器IP>:8999/ → 服务配置核对 → 实时识别测试
```

---

## 附录：版本对应

| 组件 | 版本 |
|------|------|
| vllm-ascend | v0.22.1rc1 |
| CANN | 9.0.1 |
| Qwen3-ASR | 1.7B |
| MediaFlow | 1.7.0 |
```
