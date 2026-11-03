# Gateway

The one public entry point for Caller Whale's servers. It routes by host name to the service behind it, and checks every request first. The services behind it check again for themselves: the gateway narrows what reaches them, it doesn't replace their checks. Plan and decisions: [docs/plans/gateway.md](../../docs/plans/gateway.md).

| | |
| --- | --- |
| Part | Platform service (server) |
| Language | Go (standard library only) |
| Default port | 8100 |
| Owns data | No |
| Settings | [env/gateway.env.example](../../env/gateway.env.example) |

## What it does

| Check | Where |
| --- | --- |
| Unknown host: not found | every request |
| One spelling per path: `..`, `//`, encoded slashes and NUL are refused | every request |
| Rate limit per address (and per signed-in person on the core API) | every request |
| The human check (Google reCAPTCHA v3) on sign-up, sign-in and provider starts, once per request; a start by address is refused. Off unless `HUMAN_CHECK=true` | auth host (`AUTH_HOST`) |
| Only the auth service's real routes are answered; anything else (even a real path with the wrong method) is the same plain 404 | auth host (`AUTH_HOST`) |
| An address that asks for too many things that are not there (`SCAN_LIMIT` in `SCAN_WINDOW_MINUTES`) is paused for `SCAN_PAUSE_MINUTES` | every host |
| `/healthz` and `/version` (the gateway's and the core API's) are not reachable through the public proxy; the container's own health check still works | every host |
| `/internal/*` and `/readyz` are never reachable: not found | core API host |
| A Caller Whale token from the auth service (EdDSA signature with its public keys, issuer, audience, expiry) on everything under `/api/v1`, `/sync` and `/events` except the public list (`/api/v1/auth/service`, `/api/v1/plans`, `/api/v1/download/*`, the billing webhook) | core API host |
| The authenticator step (the token's `mfa` claim) on `/api/v1/platform/*` | core API host |
| `X-WEBAUTH-*`, `X-Real-IP` and the caller's own `X-Forwarded-*` headers are dropped; the real address is set | every request |
| Everything else (Grafana's login proxy): passed on after the limits | other hosts |

WebSockets pass through; the token for `/events` is read from the `Sec-WebSocket-Protocol` list (`bearer.<token>`).

## Run and test

```bash
cd services/gateway && go test ./...
cd services/gateway && ROUTES=localhost=http://127.0.0.1:8088 CORE_HOST=localhost AUTH_JWKS_URL=http://127.0.0.1:8101/.well-known/jwks.json go run .
```

`GET /healthz` and `GET /version` answer only when there is no proxy in front (no `X-Forwarded-For`): the container's own health check, or a call from inside the private network. Through the public name they are a plain 404. `service health` is the container's health check.

## Things to know

- **Human check.** The gateway verifies the token with Google (an 8 second limit, no redirects, no address sent); a missing, reused, expired, wrong-action, wrong-site, low-score or unverifiable token is a 403 `human_required`, and Google being unreachable also refuses (it fails closed). It also edits `GET /v1/security` so the pages see the check is on with the site key, because auth itself answers "off". Auth must run with `AUTH_BOT_PROTECTION=false` and be reachable only through this gateway (no public route of its own), or the check can be walked around. Per-route scores are in `ruleFor` in `human.go`; payment routes get their own rule there.

- Run it only behind a trusted proxy (Coolify's Traefik) and set `PROXY_HOPS` to match, or callers could choose their own address for the rate limit.
- The limits are in memory, per copy. With several copies each counts for itself; move them to Redis when there is more than one.
- Only Caller Whale tokens are checked. The retired auth service's tokens are refused at the gateway.

`MONITORING_UPSTREAM` routes CORE_HOST `/staff/monitoring/` to the private Grafana proxy. The proxy validates its path-scoped HttpOnly session and asks the core API to check the auth token and staff role on every request. No Grafana hostname is required.
