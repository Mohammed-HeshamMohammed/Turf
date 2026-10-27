#!/usr/bin/env bash
# Runs the Rust API against the local development services (dev-services.sh). Development settings only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# Without PostgreSQL's tools on the PATH (Windows with the portable build), start the database yourself and run
# services/core-api/scripts/dev_db.py once instead.
if command -v pg_ctl >/dev/null; then bash "$here/dev-services.sh" >/dev/null; fi
# Settings and secrets come from env/core-api.env (env/README.md); a variable already set wins.
. "$here/../../../tools/load-env.sh" "$here/../../../env/core-api.env"
# People sign in with the auth service (services/auth, port 8101; start it first, its public keys are fetched at start)
# or with Firebase (TURF_FIREBASE_PROJECT). The website is served from here.
export TURF_SITE_DIR="${TURF_SITE_DIR:-$here/../website}"
export TURF_ARTIFACT_DIR="${TURF_ARTIFACT_DIR:-${TURF_DATA:-/x/turf-data}/artifacts}"
cd "$here/../rust"
exec cargo run -q -p turf-api
