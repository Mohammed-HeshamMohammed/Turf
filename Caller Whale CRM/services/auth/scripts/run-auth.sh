#!/usr/bin/env bash
# Runs the auth service for development. Settings and the signing key come from env/auth.env (env/README.md); it needs PostgreSQL
# (DATABASE_URL) and AUTH_FIREBASE_API_KEY.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../../../tools/load-env.sh" "$here/../../../env/auth.env"
cd "$here/.."
exec go run .
