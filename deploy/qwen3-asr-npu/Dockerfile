FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ffmpeg libsndfile1 gcc python3-dev wget \
    && rm -rf /var/lib/apt/lists/*

RUN pip install torch==2.4.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir qwen-asr torchcodec fastapi uvicorn python-multipart

WORKDIR /app
COPY asr_api.py /app/asr_api.py

EXPOSE 8022
CMD ["python3", "/app/asr_api.py"]
