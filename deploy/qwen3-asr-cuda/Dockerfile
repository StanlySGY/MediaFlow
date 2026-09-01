# Qwen3-ASR 流式服务 · NVIDIA CUDA 版
#
# 与 deploy/qwen3-asr-npu/ 的区别：那套跑昇腾 NPU（需要 torch_npu + CANN 驱动透传），
# 这套跑通用 N 卡，只要宿主机装了 NVIDIA 驱动 + nvidia-container-toolkit 即可。
# 代码里 torch_npu 的 import 被 `if settings.device != "npu"` 挡住了
# （asr-deploy-code/engine.py:193），所以镜像内不需要任何昇腾组件。
#
# 构建（在仓库根目录执行，注意 . 是根目录，因为要 COPY asr-deploy-code/）：
#   docker build -f deploy/qwen3-asr-cuda/Dockerfile -t qwen3-asr:cuda .

FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

# 服务用 ffmpeg 解各种音频容器（config.ffmpeg_bin 默认就叫 "ffmpeg"，需在 PATH 里）
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# uvicorn 必须带 [standard] 才有 websockets，否则 /v1/asr/stream 直接 404
# qwen-asr 不加 [vllm] 就够：引擎走 Qwen3ASRModel.from_pretrained，不用 vLLM 后端
RUN pip install --no-cache-dir \
      "uvicorn[standard]==0.35.0" \
      "fastapi==0.116.1" \
      "pydantic==2.11.7" \
      "pydantic-settings==2.10.1" \
      "python-multipart==0.0.20" \
      "numpy==2.1.2" \
      "soundfile==0.13.1" \
      "transformers==4.57.1" \
      "qwen-asr==0.1.4"

WORKDIR /srv

# 目录名带连字符，不是合法 Python 包名，而 main.py 用的是相对导入 + 硬编码
# "app.main:app"，所以这里必须重命名成 app/
COPY asr-deploy-code/ /srv/app/

# 权重不进镜像，靠 compose 挂进来（几 GB 的东西烤进镜像既慢又没法换模型）
ENV ASR_MODEL_PATH=/models/Qwen3-ASR-1.7B \
    ASR_DEVICE=cuda \
    ASR_HOST=0.0.0.0 \
    ASR_PORT=8022 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HUB_OFFLINE=1

EXPOSE 8022

# 起来先让 /healthz 通，模型在后台加载；编排系统用 /readyz 判断何时挂流量
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8022/healthz',timeout=3).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8022"]
