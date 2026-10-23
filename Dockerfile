# ==========================================
# Stage 1: Build the React Application
# ==========================================
FROM node:22-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
# Node 22 matches CI (setup-node: 22) and the dev host, so one toolchain
# versions the SPA everywhere.
#
# The install is retried against a completeness check, not just npm's exit code.
# Two things have to be true before the layer is worth caching: devDependencies
# are present (the build needs TypeScript/Vite even when the build environment
# inherits production-only npm settings) and rolldown's native binding actually
# resolved. That binding is an *optional* dependency, so when npm's fetch of the
# ~9 MB tarball fails — a flaky proxy is enough — npm reports the install as a
# success with the binding quietly left out, the layer caches as a good one, and
# the failure only surfaces layers later as rolldown's "Cannot find native
# binding. npm has a bug related to optional dependencies" (npm/cli#4828) on
# `npm run build`. Checking here turns that into a retry instead.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
        npm ci --include=dev --no-audit --no-fund \
            && node -e "import('rolldown').then(() => console.log('rolldown native binding ok'))" \
            && break; \
        echo "frontend dependency install attempt ${attempt} incomplete (npm/cli#4828 drops optional deps); retrying" >&2; \
        sleep 3; \
    done; \
    node -e "import('rolldown').then(() => console.log('rolldown native binding ok'))"

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
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_RETRIES=10 \
    PIP_TIMEOUT=60

# Retries are set explicitly because this host builds through a proxy that drops
# mid-transfer: apt's default is no retry, and one timed-out .deb (ffmpeg pulls
# ~1GB of libs) fails the whole layer at the end of a long download.
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
# Retried as a whole layer rather than left to pip's own retry budget: this
# host builds through a proxy that sometimes drops a transfer mid-download,
# which surfaces as ProtocolError / BrokenPipeError instead of a timed-out
# request, and PIP_RETRIES only re-issues HTTP requests. Each attempt is then
# checked against the pin list, because an install that "succeeds" while
# quietly leaving something out would cache as a good layer and fail later,
# which is exactly how the npm layer above had to be fixed.
#
# pip freeze is taken once into a variable and each pin is matched against
# that copy: piping it straight into `grep -q` lets grep exit on the first
# match, pip receives SIGPIPE, and the check buries a real verdict under a
# BrokenPipeError traceback from pip's own freeze command.
RUN set -eux; \
    check_pins() { \
        installed="$(pip freeze)"; \
        missing=0; \
        while IFS= read -r pin; do \
            case "$pin" in ""|\#*) continue ;; esac; \
            case "$pin" in *==*) ;; *) continue ;; esac; \
            name="${pin%%==*}"; ver="${pin##*==}"; \
            name="${name%%\[*\]}"; ver="${ver%% *}"; \
            if ! printf '%s\n' "$installed" | grep -iE "^${name}(\[[^]]*\])?==${ver}$" >/dev/null; then \
                echo "pin not satisfied: $pin" >&2; missing=1; \
            fi; \
        done < requirements.txt; \
        [ "$missing" -eq 0 ]; \
    }; \
    for attempt in 1 2 3 4 5; do \
        if pip install -r requirements.txt && check_pins; then break; fi; \
        echo "pip install attempt ${attempt} incomplete; retrying the layer" >&2; \
        sleep 3; \
    done; \
    check_pins
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
