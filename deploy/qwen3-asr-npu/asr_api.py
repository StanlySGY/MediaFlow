from fastapi import FastAPI, UploadFile, File, HTTPException
import os
import traceback

print("Python startup OK", flush=True)

from qwen_asr import Qwen3ASRModel

app = FastAPI()
asr_model = None
MODEL_DIR = "/app/models/Qwen3-ASR-1.7B"

def get_model():
    global asr_model
    if asr_model is None:
        print(f"Loading model from {MODEL_DIR}...", flush=True)
        if not os.path.exists(MODEL_DIR):
            raise Exception(f"Model directory not found: {MODEL_DIR}")
        asr_model = Qwen3ASRModel.from_pretrained(MODEL_DIR)
        print("Model ready", flush=True)
    return asr_model

@app.get("/v1/models")
def list_models():
    get_model()
    return {"object":"list","data":[{"id":"qwen3-asr-1.7b"}]}

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
        result = model.transcribe(tmp_path)

        text = ""
        if isinstance(result, list) and len(result) > 0:
            item = result[0]
            if hasattr(item, 'text'):
                text = item.text
            elif isinstance(item, dict):
                text = item.get('text', '')
            else:
                text = str(item)
        elif hasattr(result, 'text'):
            text = result.text
        elif isinstance(result, dict):
            text = result.get('text', '')
        else:
            text = str(result)

        print(f"Done: {text[:50]}...", flush=True)
        return {"text": text}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

if __name__ == "__main__":
    print("Start uvicorn 0.0.0.0:8022", flush=True)
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8022, log_level="info")
