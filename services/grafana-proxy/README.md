# Grafana login proxy

Lets only Caller Whale's platform owner, cofounder, and system administrators into Grafana after MFA. Auth validates the session (`GET /v1/me`) and returns the current platform role (`GET /v1/me/access`). The proxy passes the approved identity to Grafana in its auth-proxy headers (`X-WEBAUTH-USER`, `-EMAIL`, `-NAME`, `-ROLE`). Plan and progress: [docs/operations/grafana-access.md](../../docs/operations/grafana-access.md).

The gateway routes `/staff/monitoring/` to this proxy. Neither the proxy nor Grafana has its own public domain.

## How sign-in works

1. A visit without a session, inside the admin page's frame, asks that page to post a sign-in; a direct visit is refused.
2. The website, already signed in, posts the person's Caller Whale token to `/_callerwhale/session` (a form post, so the token is never in a URL). Only the website's origin may post it.
3. The proxy asks Auth for the current session, MFA state, and platform role. If the person is staff, it sets the `callerwhale_grafana` cookie (a random session id, HttpOnly, Secure, SameSite=Lax) and sends them back to the path.
4. Every request carries their id, email, name and Grafana role to Grafana. Headers the browser sent with those names, `Authorization` and the proxy's own cookie are removed first.
5. At most once a `RECHECK_EVERY` it asks Auth again with the token it keeps in memory. If staff access is gone, the session ends at once. An expired token means signing in again. If Auth cannot answer, nobody gets through until it answers.

The owner and cofounder are Grafana `Admin`; system administrators get `ADMIN_GRAFANA_ROLE`. Sessions live in memory: run one copy; a restart only means signing in again.

## Settings

| Variable | Default | What |
| --- | --- | --- |
| `GRAFANA_URL` | required | Grafana on the private network, e.g. `http://grafana:3000` |
| `CALLERWHALE_AUTH_URL` | required | Auth service, e.g. `https://auth.callerwhale.example` |
| `CALLERWHALE_WEBSITE_URL` | required | The website with the admin dashboard; its origin is the only one allowed to post a sign-in |
| `ADMIN_GRAFANA_ROLE` | `Editor` | `Viewer`, `Editor` or `Admin` for system administrators |
| `RECHECK_EVERY` | `60s` | How often access is asked again |
| `SESSION_MAX_AGE` | `1h` | Longest a session lasts |
| `IDLE_TIMEOUT` | `10m` | A session ends after this long with no request |
| `AUTH_WITHIN` | `15m` | Longest since the person signed in (authenticator code included) for a new session to open |
| `COOKIE_SECURE` | on | `false` only for local http |
| `PORT` | `8120` | |

Health: `GET /_callerwhale/health`, or `/service health` inside the container (exit code 0 when healthy).

## Test

```bash
cd services/grafana-proxy && go test ./...
```

The tests use a fake Auth service and a fake Grafana. They cover:
- forged headers and cookies
- sign-ins posted from other sites
- the owner's and admins' roles
- refusal on re-check
- an expired token
- an Auth service that's down
- the return path never leaving the site
