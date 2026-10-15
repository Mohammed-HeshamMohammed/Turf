#!/usr/bin/env bash
# Runs the Go worker against the local API (run-api.sh). Development settings only.
set -euo pipefail
[ -f "${TURF_TOOLS:-/x/tools/env.sh}" ] && source "${TURF_TOOLS:-/x/tools/env.sh}"
here="$(cd "$(dirname "$0")" && pwd)"
export TURF_API_URL="${TURF_API_URL:-http://127.0.0.1:8088}"
export TURF_WORKER_TOKEN="${TURF_WORKER_TOKEN:-dev-worker-token-change-me-0000}"
export REDIS_ADDR="${REDIS_ADDR:-127.0.0.1:56379}"
cd "$here/../go"
exec go run ./cmd/turf-worker
