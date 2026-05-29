# ==========================================
# Stage 1: Build the React Application
# ==========================================
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ==========================================
# Stage 2: Create the Python Runner
# ==========================================
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app
# Copy built static assets from the node build stage
COPY --from=frontend-builder /app/web ./app/web

ENV HOST=0.0.0.0 PORT=8999
EXPOSE 8999

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8999"]
