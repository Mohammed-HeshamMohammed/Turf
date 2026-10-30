#!/usr/bin/env bash
# Runs the Go worker against the local API (run-api.sh). Development settings only.
set -euo pipefail
[ -f "${CALLERWHALE_TOOLS:-/x/tools/env.sh}" ] && source "${CALLERWHALE_TOOLS:-/x/tools/env.sh}"
here="$(cd "$(dirname "$0")" && pwd)"
# Settings and the worker's token come from env/worker.env (env/README.md); a variable already set wins.
. "$here/../../../tools/load-env.sh" "$here/../../../env/worker.env"
cd "$here/../go"
exec go run ./cmd/callerwhale-worker
