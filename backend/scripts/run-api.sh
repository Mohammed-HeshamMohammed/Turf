#!/usr/bin/env bash
# Runs the Rust API against the local development services (dev-services.sh). Development settings only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bash "$here/dev-services.sh" >/dev/null
export DATABASE_URL="${DATABASE_URL:-postgres://turf_api:turf_api@127.0.0.1:55432/turf}"
export MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-postgres://turf_owner:turf_owner@127.0.0.1:55432/turf}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:56379}"
export TURF_BIND="${TURF_BIND:-127.0.0.1:8088}"
export TURF_SECURE_COOKIES=false
export TURF_ALLOWED_ORIGINS="${TURF_ALLOWED_ORIGINS:-http://localhost:5190,http://127.0.0.1:5190}"
export TURF_WORKER_TOKENS="${TURF_WORKER_TOKENS:-dev=dev-worker-token-change-me-0000}"
export TURF_ARTIFACT_DIR="${TURF_ARTIFACT_DIR:-${TURF_DATA:-/x/turf-data}/artifacts}"
cd "$here/../rust"
exec cargo run -q -p turf-api
