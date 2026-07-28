"""
Qwen3-ASR 自定义 FastAPI 服务（备选方案）

注意：推荐使用 vllm serve 方式部署（见 docker-compose.yml），
本文件仅作为需要自定义接口时的备选方案。

使用方式：
  python asr_api.py

依赖：
  pip install "qwen-asr[vllm]" fastapi uvicorn python-multipart
"""

from fastapi import FastAPI, UploadFile, File, HTTPException
import os
import traceback

print("Python startup OK", flush=True)

import torch
from qwen_asr import Qwen3ASRModel

app = FastAPI(title="Qwen3-ASR API")
asr_model = None
MODEL_DIR = os.environ.get("MODEL_DIR", "/data/models/Qwen3-ASR-1.7B")


def get_model():
    global asr_model
    if asr_model is None:
        print(f"Loading model from {MODEL_DIR}...", flush=True)
        if not os.path.exists(MODEL_DIR):
            raise Exception(f"Model directory not found: {MODEL_DIR}")

        # 检测可用设备
        if torch.cuda.is_available():
            device_map = "cuda:0"
        elif hasattr(torch, "npu") and torch.npu.is_available():
            device_map = "npu:0"
        else:
            device_map = "cpu"
            print("Warning: No GPU/NPU available, using CPU (slow)", flush=True)

        # 使用 vLLM 后端（推荐）
        try:
            from qwen_asr import Qwen3ASRModel

            asr_model = Qwen3ASRModel.LLM(
                model=MODEL_DIR,
                gpu_memory_utilization=0.9,
                max_inference_batch_size=32,
                max_new_tokens=4096,
            )
            print(f"Model ready (vLLM backend, device: {device_map})", flush=True)
        except Exception as e:
            print(f"vLLM backend failed, falling back to transformers: {e}", flush=True)
            # 回退到 transformers 后端
            asr_model = Qwen3ASRModel.from_pretrained(
                MODEL_DIR,
                dtype=torch.bfloat16,
                device_map=device_map,
                max_inference_batch_size=32,
                max_new_tokens=4096,
            )
            print(f"Model ready (transformers backend, device: {device_map})", flush=True)

    return asr_model


@app.get("/v1/models")
def list_models():
    get_model()
    return {"object": "list", "data": [{"id": "qwen3-asr-1.7b"}]}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    model = get_model()
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    tmp_path = f"/tmp/{file.filename}"
    with open(tmp_path, "wb") as f:
        f.write(content)

    try:
        print(f"Transcribing {tmp_path}...", flush=True)
        results = model.transcribe(audio=tmp_path, language=None)

        if isinstance(results, list) and len(results) > 0:
            result = results[0]
            text = result.text if hasattr(result, "text") else str(result)
        elif hasattr(results, "text"):
            text = results.text
        elif isinstance(results, dict):
            text = results.get("text", "")
        else:
            text = str(results)

        print(f"Done: {text[:50]}...", flush=True)
        return {"text": text}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    print(f"Start uvicorn 0.0.0.0:{port}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
