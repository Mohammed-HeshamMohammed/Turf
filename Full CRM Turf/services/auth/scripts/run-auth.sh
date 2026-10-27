#!/usr/bin/env bash
# Runs the auth service for development, on SQLite (services/auth/auth.db) unless env/auth.env says otherwise.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# Settings and the signing key come from env/auth.env (env/README.md); a variable already set wins.
. "$here/../../../tools/load-env.sh" "$here/../../../env/auth.env"
cd "$here/.."
exec cargo run -q -p turf-auth
