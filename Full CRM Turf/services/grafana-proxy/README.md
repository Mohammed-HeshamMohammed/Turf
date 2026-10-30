# Grafana login proxy

Lets only Turf's staff into Grafana: the platform owner and system administrators, after the authenticator step. It asks the core API (`GET /api/v1/platform/whoami`) and passes the answer to Grafana in its auth-proxy headers (`X-WEBAUTH-USER`, `-EMAIL`, `-NAME`, `-ROLE`). Plan and progress: [docs/plans/grafana-access.md](../../docs/plans/grafana-access.md).

Not behind the gateway: it is its own way in, with its own domain (in Coolify, the only service of the Grafana resource with one).

## How sign-in works

1. A visit without a session, inside the admin page's frame, asks that page to post a sign-in; a direct visit is refused.
2. The website, already signed in, posts the person's Turf token to `/_turf/session` (a form post, so the token is never in a URL). Only the website's origin may post it.
3. The proxy asks `whoami`. If the person is staff, it sets the `turf_grafana` cookie (a random session id, HttpOnly, Secure, SameSite=Lax) and sends them back to the path.
4. Every request carries their id, email, name and Grafana role to Grafana. Headers the browser sent with those names, `Authorization` and the proxy's own cookie are removed first.
5. At most once a `RECHECK_EVERY` it asks `whoami` again with the token it keeps in memory. If staff access is gone, the session ends at once. An expired token means signing in again. If the core API can't be reached, nobody gets through until it answers.

The owner is Grafana's `Admin`, and system administrators get `ADMIN_GRAFANA_ROLE`. Sessions live in memory: run one copy; a restart only means signing in again.

## Settings

| Variable | Default | What |
| --- | --- | --- |
| `GRAFANA_URL` | required | Grafana on the private network, e.g. `http://grafana:3000` |
| `TURF_CORE_API_URL` | required | The core API, e.g. `https://api.turf.example` |
| `TURF_WEBSITE_URL` | required | The website with the admin dashboard; its origin is the only one allowed to post a sign-in |
| `ADMIN_GRAFANA_ROLE` | `Editor` | `Viewer`, `Editor` or `Admin` for system administrators |
| `RECHECK_EVERY` | `60s` | How often access is asked again |
| `SESSION_MAX_AGE` | `8h` | Longest a session lasts |
| `COOKIE_SECURE` | on | `false` only for local http |
| `PORT` | `8120` | |

Health: `GET /_turf/health`, or `/service health` inside the container (exit code 0 when healthy).

## Test

```bash
cd services/grafana-proxy && go test ./...
```

The tests use a fake core API and a fake Grafana. They cover:
- forged headers and cookies
- sign-ins posted from other sites
- the owner's and admins' roles
- refusal on re-check
- an expired token
- a core API that's down
- the return path never leaving the site
