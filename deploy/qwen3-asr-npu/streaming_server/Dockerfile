# Qwen3-ASR 真正流式识别服务
#
# 基于 Ascend vLLM 官方镜像，包装 qwen-asr 库的 streaming_transcribe() 增量流式
# API，对外暴露与 MediaFlow RealtimeHTTPProvider 兼容的 HTTP+SSE 协议。
#
# 与 vllm serve（见 ../docker-compose.yml）的区别：本服务边说边出字，是真正的
# 流式识别，需要独占一张 NPU 卡。

FROM quay.io/ascend/vllm-ascend:v0.22.1rc1

# ffmpeg：把浏览器 MediaRecorder 的 webm/ogg 增量流解码为 16k 单声道 PCM
RUN (apt-get update && apt-get install -y --no-install-recommends ffmpeg \
      && rm -rf /var/lib/apt/lists/*) \
    || (yum install -y ffmpeg || true)

RUN pip install --no-cache-dir "qwen-asr[vllm]" fastapi uvicorn numpy

WORKDIR /app
COPY server.py /app/server.py

# 模型目录（运行时通过 volume 挂载）
ENV MODEL_DIR=/data/models/Qwen3-ASR-1.7B

EXPOSE 8001

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]
