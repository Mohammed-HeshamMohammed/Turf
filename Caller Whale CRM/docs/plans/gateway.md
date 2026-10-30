# Gateway: the front door for everything

**Status:** built (2026-10-30), not yet the public entry in Coolify. Code: `services/gateway`. Settings: `env/gateway.env.example`.

## Why

Each server used to sit on its own public name and do its own checks. The gateway is the one public entry that checks first (name, path, token, staff step, rate), and the services behind it keep their own checks (the core API verifies tokens and roles again; the Grafana login proxy keeps its sign-in window and idle timeout). Two layers: a mistake in one is caught by the other.

## Layout

```
Cloudflare DNS ──► Coolify Traefik (TLS) ──► gateway ──► core-api         (app.callerwhale.com)
                                                    ├──► grafana-proxy ──► Grafana   (grafana.callerwhale.com)
                                                    └──► auth          (auth.callerwhale.com, no token check: it is where tokens are made)
callerwhale.com ──► landing-web, landing-api   (marketing site: no tokens, stays as it is)
```

- `app.callerwhale.com` and `grafana.callerwhale.com` both point at the gateway (port 8100). `core-api` and `grafana-proxy` have **no domain** and are reached on the private Docker network.
- `ROUTES` maps each host to its upstream. `CORE_HOST` marks the core API, whose paths get the policy.

## The policy on the core API host

| Path | Needs |
| --- | --- |
| `/healthz`, the website's own files | nothing |
| `GET /api/v1/auth/service`, `GET /api/v1/plans`, `GET /api/v1/download/*`, `POST /api/v1/billing/webhook` | nothing (the webhook is signed; the download link is signed) |
| `/internal/*`, `/readyz` | never: not found from outside |
| `/api/v1/platform/*` | a valid Caller Whale token **with the authenticator step** (`mfa`) |
| everything else under `/api/v1`, `/sync/*`, `/events` | a valid Caller Whale token |

Tokens are the auth service's: checked for signature (its Ed25519 keys from `AUTH_JWKS_URL`, cached by their `max-age`, refetched on an unknown key at most every 30 s), issuer, audience and expiry. The gateway knows nothing about how people sign in; Firebase is the auth service's business alone. The person's role, organization and revocation are still the core API's call.

## Coolify steps

1. **New application** from the `gateway-backend-production` branch: build type Dockerfile, `services/gateway/Dockerfile`, port 8100. Environment from `env/gateway.env.example`. `ROUTES` upstreams are the other applications' network aliases (see below).
2. Check it answers `/healthz` and routes, with a temporary domain or from the server.
3. **Move the domains.** Remove `app.callerwhale.com` from core-api and `grafana.callerwhale.com` from grafana-proxy; add both to the gateway, port 8100. Redeploy the three. No `www.` copies.
4. Set core-api's `CALLERWHALE_BIND` to listen on all interfaces on the private network (as now); it keeps no public domain.
5. Check from outside: `https://app.callerwhale.com/internal/jobs/claim` is 404; `/api/v1/leads` without a token is 401; `/api/v1/platform/people` with a token without the authenticator step is 403; the CRM signs in and syncs.

## Not done yet

- Limits are per copy and in memory.
- The landing site and its API (`callerwhale.com`) are not behind it: they are static and public. Its `/api` has its own limits.
- Admin mode's invitations call the core API through the gateway like any other staff call.

## Log

- 2026-10-30: Gateway built: host routing, path hygiene, per-address and per-person limits, token check, staff step, private paths, header hygiene, WebSocket pass-through. 18 tests (token forgery cases included).
