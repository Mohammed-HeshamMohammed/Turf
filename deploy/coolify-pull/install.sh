#!/bin/sh
# Installs the deploy puller on the VPS (docs/plans/coolify-image-swap.md, "Deploys from GitHub"). Run as root on the server,
# for example in Coolify's Terminal for the server. It asks for a Coolify API token (write and deploy, every moved application)
# without showing it, stores it readable by root only, and starts a timer that applies approved deploys every two minutes.
# Running it again updates the puller's files and keeps the token and what was already applied.
set -eu

DIR=/opt/callerwhale-deploy
RAW=https://raw.githubusercontent.com/Mohammed-HeshamMohammed/Turf/main/tools

command -v docker >/dev/null || { echo "docker is needed (Coolify installs it)"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/health || true)
[ "$code" = 200 ] || { echo "Coolify does not answer on http://localhost:8000/api/health (got $code)"; exit 1; }

mkdir -p "$DIR"
chmod 700 "$DIR"
curl -fsSL -o "$DIR/coolify-deploy.mjs" "$RAW/coolify-deploy.mjs"
curl -fsSL -o "$DIR/coolify-pull.mjs" "$RAW/coolify-pull.mjs"

if [ ! -s "$DIR/env" ]; then
  printf 'Coolify API token (write and deploy; it is not shown): '
  stty -echo 2>/dev/null || true
  read -r token
  stty echo 2>/dev/null || true
  echo
  [ -n "$token" ] || { echo "no token given"; exit 1; }
  umask 077
  printf 'COOLIFY_TOKEN=%s\nCOOLIFY_URL=http://localhost:8000\nSTATE_FILE=/app/state.json\n' "$token" > "$DIR/env"
  unset token
fi
chmod 600 "$DIR/env"

RUN="/usr/bin/docker run --rm --network host --env-file $DIR/env -v $DIR:/app -w /app node:24-alpine node coolify-pull.mjs"

cat > /etc/systemd/system/callerwhale-coolify-pull.service <<EOF
[Unit]
Description=Apply Caller Whale deploys approved in GitHub to Coolify
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$RUN
EOF

cat > /etc/systemd/system/callerwhale-coolify-pull.timer <<EOF
[Unit]
Description=Check GitHub for approved Caller Whale deploys every two minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF

# The first time, remember the newest deployment so nothing older is replayed.
[ -s "$DIR/state.json" ] || $RUN --init

systemctl daemon-reload
systemctl enable --now callerwhale-coolify-pull.timer
echo "Installed. Logs: journalctl -u callerwhale-coolify-pull -n 50"
