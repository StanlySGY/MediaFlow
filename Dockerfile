# ==========================================
# Stage 1: Build the React Application
# ==========================================
FROM node:20-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
# The build needs TypeScript/Vite from devDependencies even when the Docker
# build environment inherits production-only npm settings.
RUN npm ci --include=dev
COPY frontend/ ./
RUN npm run build

# Vendor the Swagger UI bundle next to the built SPA. FastAPI's stock /docs page
# pulls these from cdn.jsdelivr.net, which renders blank on the air-gapped host
# this image ships to; app/main.py serves them from /swagger/* when present.
# Copied after the build so Vite cannot wipe the directory.
RUN mkdir -p /app/web/swagger \
    && cp node_modules/swagger-ui-dist/swagger-ui-bundle.js node_modules/swagger-ui-dist/swagger-ui.css /app/web/swagger/

# ==========================================
# Stage 2: Create the Python Runner
# ==========================================
# Pin the Debian release so a floating-tag transition cannot silently change
# the system package set used for FFmpeg; this matches the current Trixie runtime.
FROM python:3.12-slim-trixie

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

# Run as an unprivileged user: the output/config/temp volumes are writable by it
# (created below), and a compromised request handler cannot replace files
# outside them. Ownership is set before the switch so no runtime chown is needed.
RUN useradd --create-home --uid 10001 mediaflow \
    && mkdir -p /app/temp /app/outputs /app/config \
    && chown -R mediaflow:mediaflow /app/temp /app/outputs /app/config
USER mediaflow

ENV HOST=0.0.0.0 PORT=8999
EXPOSE 8999

# Signals reach uvicorn directly (no shell wrapper), so SIGTERM starts the
# graceful shutdown path in app.main — in-flight tasks are awaited briefly and
# their state is checkpointed as interrupted instead of dying mid-write.
STOPSIGNAL SIGTERM
CMD ["python", "-m", "app.main"]
