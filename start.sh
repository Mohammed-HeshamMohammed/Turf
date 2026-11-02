#!/bin/sh
set -eu
service="Dashboard"
export NGINX_ENTRYPOINT_QUIET_LOGS=1
printf '[→ CHECK] Caller Whale %s | Preparing configuration\n' "$service"
if ! output=$(/docker-entrypoint.d/20-envsubst-on-templates.sh 2>&1); then
  printf '[✗ FAILED] Caller Whale %s | Could not prepare configuration\n%s\n' "$service" "$output" >&2
  exit 1
fi
# Keep template warnings visible, even when template generation succeeds.
if [ -n "$output" ]; then printf '%s\n' "$output" >&2; fi
if ! output=$(nginx -t 2>&1); then
  printf '[✗ FAILED] Caller Whale %s | Invalid web server configuration\n%s\n' "$service" "$output" >&2
  exit 1
fi
printf '[✓ PASS] Caller Whale %s | Web server configuration is valid\n' "$service"
printf '[→ START] Caller Whale %s | Starting on container port 8080. Coolify checks readiness.\n' "$service"
exec nginx -g 'daemon off;'
