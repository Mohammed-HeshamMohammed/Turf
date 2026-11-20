# Live server

Centrifugo (v6, pinned in the Dockerfile) with Caller Whale's own settings, so the live server is code that is reviewed, tested and versioned like every other service. It holds the apps' sockets and delivers what the messaging service tells it. It stores nothing: messages live only in the messaging database.

| File | What it is |
| --- | --- |
| `config.json` | Every setting that is not a secret: log level, the `chat` channel rules, the health and metrics addresses, and the connection limits (5 per person, 1000 in all). |
| `Dockerfile` | Centrifugo plus the shared Runtime Logs table (`callerwhale-log`), so the Runtime Logs tab reads like the other services. |
| `config.test.mjs` | Checks the file keeps secrets out, keeps chat channels private to their owner, and keeps the limits. Run: `node --test services/live`. |

## Secrets stay in Coolify

Environment variables win over `config.json`, so the secrets and anything that differs per server are set in Coolify (see `env/centrifugo.production.example`): the API key, the token secret, the allowed origins and the Redis engine (`CENTRIFUGO_ENGINE_TYPE`, `CENTRIFUGO_ENGINE_REDIS_ADDRESS`).

## Public and private

Only the WebSocket (`/connection/websocket`) is public, and only because the gateway says so: set `LIVE_HOST=live.callerwhale.com` on the gateway and it answers nothing else on that host. The API (the messaging service calls it privately at `http://centrifugo:8000/api` with its key), `/metrics` and `/health` stay on the private network.

## Metrics

`/metrics` (Prometheus format) is on at port 8000 inside the network: connections, messages, delays. Point a scrape at `http://centrifugo:8000/metrics` from Grafana's data source.

## Deploy (Coolify)

Branch `live-backend-production` (published by `tools/publish-production.mjs`), build pack Dockerfile, base directory `/`, Dockerfile `/Dockerfile`, port 8000, no domain of its own. Health check: `GET http://localhost:8000/health`, expect 200. The alias `centrifugo` must stay.

## Not verified

The container has not been built or run on the build machine (no Docker there): the first Coolify build is the real check. If the log says a setting is unknown, Centrifugo prints a warning and starts anyway; if it refuses to start, the log names the key.
