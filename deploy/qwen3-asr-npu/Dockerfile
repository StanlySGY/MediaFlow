# Qwen3-ASR NPU 部署 - 基于 Ascend vLLM 官方镜像
# 支持华为昇腾 NPU 硬件加速（910B / 310P）
#
# 使用方式：
#   1. 直接使用 vllm serve（推荐）
#   2. 使用 asr_api.py 自定义接口（可选）
#
# 参考文档：https://docs.vllm.ai/projects/ascend/en/latest/tutorials/models/Qwen3-ASR-1.7B.html

FROM quay.io/ascend/vllm-ascend:v0.22.1rc1

# 安装 qwen-asr（提供 qwen-asr-serve 命令，可选）
RUN pip install --no-cache-dir "qwen-asr[vllm]"

WORKDIR /app

# 模型目录（运行时通过 volume 挂载）
ENV MODEL_DIR=/data/models/Qwen3-ASR-1.7B

# 暴露端口
EXPOSE 8000

# 默认启动命令：使用 vLLM 提供 OpenAI 兼容接口
# 支持 /v1/chat/completions 和 /v1/audio/transcriptions
CMD ["sh", "-c", "vllm serve ${MODEL_DIR} --served-model-name qwen3-asr --tensor-parallel-size 1 --max-model-len 4096 --gpu-memory-utilization 0.9 --enforce-eager --port 8000"]
