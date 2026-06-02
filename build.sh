#!/usr/bin/env bash
# MediaFlow — one-shot Docker image builder.
# Usage:
#   ./build.sh                build mediaflow:1.4.0 + :latest (defaults to host arch)
#   ./build.sh --platform P   override target platform (e.g. linux/amd64, linux/arm64)
#   ./build.sh --save [FILE]  docker save image to a gzipped tar for offline transfer
#   ./build.sh --no-cache     skip layer cache
#   ./build.sh --pull         pull fresh base images first
#   ./build.sh --test         run backend pytest before building (requires .venv)
#   ./build.sh --tag x.y.z    override image version tag
#   ./build.sh --up           start `docker compose up -d` after a successful build
#   ./build.sh --push REG     docker push REG/mediaflow:<tag> after build
#
# Offline delivery: ./build.sh --save → copy .tar.gz → docker load -i → compose -f docker-compose.prod.yml up -d

set -euo pipefail

# ---- defaults ----
IMAGE_NAME="mediaflow"
DEFAULT_TAG="1.4.0"
TAG="$DEFAULT_TAG"
# Default to the host arch: legacy `docker build` can't cross-build, so the
# only platform that succeeds without buildx + QEMU is the machine's own.
case "$(uname -m)" in
    aarch64|arm64) PLATFORM="linux/arm64" ;;
    *)             PLATFORM="linux/amd64" ;;
esac
NO_CACHE=""
PULL=""
RUN_TESTS=0
RUN_UP=0
PUSH_REG=""
SAVE=0
SAVE_FILE=""

# ---- color helpers ----
if [[ -t 1 ]]; then
    C_BLU=$'\e[1;34m'; C_GRN=$'\e[1;32m'; C_YEL=$'\e[1;33m'
    C_RED=$'\e[1;31m'; C_DIM=$'\e[2m'; C_RST=$'\e[0m'
else
    C_BLU=""; C_GRN=""; C_YEL=""; C_RED=""; C_DIM=""; C_RST=""
fi
info()  { echo "${C_BLU}→${C_RST} $*"; }
ok()    { echo "${C_GRN}✓${C_RST} $*"; }
warn()  { echo "${C_YEL}!${C_RST} $*"; }
die()   { echo "${C_RED}✗${C_RST} $*" >&2; exit 1; }

# ---- parse args ----
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-cache) NO_CACHE="--no-cache"; shift ;;
        --pull)     PULL="--pull";        shift ;;
        --test)     RUN_TESTS=1;          shift ;;
        --up)       RUN_UP=1;             shift ;;
        --tag)      TAG="${2:?--tag needs a value}"; shift 2 ;;
        --platform) PLATFORM="${2:?--platform needs a value}"; shift 2 ;;
        --save)     SAVE=1
                    if [[ $# -ge 2 && "$2" != -* ]]; then SAVE_FILE="$2"; shift 2; else shift; fi ;;
        --push)     PUSH_REG="${2:?--push needs a registry}"; shift 2 ;;
        -h|--help)  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          die "unknown argument: $1 (use --help)" ;;
    esac
done

# ---- preflight ----
cd "$(dirname "$0")"

command -v docker >/dev/null 2>&1 \
    || die "docker not found in PATH; install Docker first."

[[ -f Dockerfile ]] || die "Dockerfile missing — run from project root."
[[ -f frontend/package.json ]] || die "frontend/package.json missing — frontend not initialized."
[[ -f requirements.txt ]] || die "requirements.txt missing."

if [[ "$RUN_TESTS" -eq 1 ]]; then
    if [[ -x .venv/bin/pytest ]]; then
        info "Running pytest before build…"
        .venv/bin/pytest -q || die "tests failed — aborting build."
        ok "pytest passed."
    else
        warn ".venv/bin/pytest not found — skipping test step."
    fi
fi

# ---- build ----
IMG_VER="${IMAGE_NAME}:${TAG}"
IMG_LAT="${IMAGE_NAME}:latest"

info "Building ${C_DIM}${IMG_VER}${C_RST} (also tagging ${C_DIM}${IMG_LAT}${C_RST})…"
echo "  context  : $(pwd)"
echo "  platform : ${PLATFORM}"
echo "  flags    : ${NO_CACHE:-} ${PULL:-}"
echo

# shellcheck disable=SC2086
docker build $NO_CACHE $PULL \
    --platform "$PLATFORM" \
    -t "$IMG_VER" \
    -t "$IMG_LAT" \
    -f Dockerfile \
    .

ok "Built ${IMG_VER}"

# ---- report ----
SIZE="$(docker image inspect "$IMG_VER" --format '{{.Size}}' 2>/dev/null || echo 0)"
HUMAN_SIZE="$(awk -v s="$SIZE" 'BEGIN{
    split("B KB MB GB TB",u," "); i=1;
    while(s>=1024 && i<5){ s/=1024; i++ }
    printf "%.1f %s", s, u[i]
}')"
IMG_ID="$(docker image inspect "$IMG_VER" --format '{{.Id}}' 2>/dev/null | sed 's/^sha256://;s/\(.\{12\}\).*/\1/')"

echo
echo "  ${C_DIM}image${C_RST}     $IMG_VER  (also tagged :latest)"
echo "  ${C_DIM}platform${C_RST}  $PLATFORM"
echo "  ${C_DIM}id${C_RST}        $IMG_ID"
echo "  ${C_DIM}size${C_RST}      $HUMAN_SIZE"
echo

# ---- optional save (offline transfer) ----
if [[ "$SAVE" -eq 1 ]]; then
    ARCH="${PLATFORM##*/}"
    SAVE_FILE="${SAVE_FILE:-${IMAGE_NAME}-${TAG}-${ARCH}.tar.gz}"
    info "Saving ${C_DIM}${IMG_VER}${C_RST} → ${C_DIM}${SAVE_FILE}${C_RST} (gzip)…"
    docker save "$IMG_VER" | gzip > "$SAVE_FILE"
    SAVED_BYTES="$(wc -c < "$SAVE_FILE")"
    SAVED_SIZE="$(awk -v b="$SAVED_BYTES" 'BEGIN{
        split("B KB MB GB TB",u," "); i=1;
        while(b>=1024 && i<5){ b/=1024; i++ }
        printf "%.1f %s", b, u[i]
    }')"
    ok "Saved ${SAVE_FILE} (${SAVED_SIZE})"
    echo "  ${C_DIM}offline next:${C_RST} copy ${SAVE_FILE} to the site, then:"
    echo "    docker load -i ${SAVE_FILE}"
    echo "    docker compose -f docker-compose.prod.yml up -d"
    echo
fi

# ---- optional push ----
if [[ -n "$PUSH_REG" ]]; then
    REMOTE_VER="${PUSH_REG%/}/${IMAGE_NAME}:${TAG}"
    REMOTE_LAT="${PUSH_REG%/}/${IMAGE_NAME}:latest"
    info "Tagging + pushing to ${PUSH_REG%/}…"
    docker tag "$IMG_VER" "$REMOTE_VER"
    docker tag "$IMG_VER" "$REMOTE_LAT"
    docker push "$REMOTE_VER"
    docker push "$REMOTE_LAT"
    ok "Pushed $REMOTE_VER and $REMOTE_LAT"
fi

# ---- optional up ----
if [[ "$RUN_UP" -eq 1 ]]; then
    info "Starting via docker compose…"
    if [[ ! -f .env ]]; then
        warn ".env not found — copying .env.example. Remember to set ASR_API_KEY."
        cp .env.example .env
    fi
    docker compose up -d
    ok "Up. Visit http://localhost:8999/"
else
    echo "${C_GRN}Next:${C_RST}"
    [[ -f .env ]] || echo "  1. cp .env.example .env && \$EDITOR .env  ${C_DIM}# set ASR_API_KEY${C_RST}"
    echo "  $([ -f .env ] && echo 1 || echo 2). docker compose up -d"
    echo "  $([ -f .env ] && echo 2 || echo 3). open http://localhost:8999/"
fi
