#!/usr/bin/env bash
# Runs the Rust API against the local development services (dev-services.sh). Development settings only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# Without PostgreSQL's tools on the PATH (Windows with the portable build), start the database yourself and run
# backend/scripts/dev_db.py once instead.
if command -v pg_ctl >/dev/null; then bash "$here/dev-services.sh" >/dev/null; fi
export DATABASE_URL="${DATABASE_URL:-postgres://turf_api:turf_api@127.0.0.1:55432/turf}"
export MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-postgres://turf_owner:turf_owner@127.0.0.1:55432/turf}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:56379}"
export TURF_BIND="${TURF_BIND:-127.0.0.1:8088}"
export TURF_SECURE_COOKIES=false
export TURF_ALLOWED_ORIGINS="${TURF_ALLOWED_ORIGINS:-http://localhost:5190,http://127.0.0.1:5190}"
export TURF_WORKER_TOKENS="${TURF_WORKER_TOKENS:-dev=dev-worker-token-change-me-0000}"
# The website, development email tokens, and the webhook secret dev_pay.py signs with.
export TURF_SITE_DIR="${TURF_SITE_DIR:-$here/../../website}"
export TURF_DEV_TOKENS="${TURF_DEV_TOKENS:-true}"
export TURF_BILLING_WEBHOOK_SECRET="${TURF_BILLING_WEBHOOK_SECRET:-dev-webhook-secret-change-me-000000}"
export TURF_CHECKOUT_URL="${TURF_CHECKOUT_URL:-}"
export TURF_ARTIFACT_DIR="${TURF_ARTIFACT_DIR:-${TURF_DATA:-/x/turf-data}/artifacts}"
cd "$here/../rust"
exec cargo run -q -p turf-api
