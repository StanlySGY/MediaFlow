# Qwen3-ASR NPU 部署 - 基于 Ascend vLLM 官方镜像
# 支持华为昇腾 NPU 硬件加速

FROM quay.io/ascend/vllm-ascend:main

# 安装额外依赖
RUN pip install --no-cache-dir qwen-asr fastapi uvicorn python-multipart

WORKDIR /app

# 模型目录（运行时通过 volume 挂载）
ENV MODEL_DIR=/app/models/Qwen3-ASR-1.7B

# 暴露端口
EXPOSE 8022

# 默认启动命令：使用 vLLM 提供 OpenAI 兼容接口
CMD ["sh", "-c", "vllm serve ${MODEL_DIR} --tensor-parallel-size 1 --max-model-len 4096 --gpu-memory-utilization 0.9 --enforce-eager --port 8022"]
