# Private Grafana in Dashboard admin mode

Grafana has no public hostname or published port. The gateway on `gate.callerwhale.com`
proxies `/staff/monitoring/` to `http://grafana-proxy:8120`. The proxy alone reaches
Grafana on its isolated network. Auth validates the session, MFA, and current platform role. Every forwarded monitoring request
rechecks access. Sessions expire on inactivity or after the configured maximum age.

Deploy `deploy/grafana/compose.yml` from `grafana-production` as a Git Docker Compose
application (build context is required). Do not assign a domain to either component.
Attach the proxy to the gateway's Coolify network (`COOLIFY_NETWORK`, default `coolify`).
Set `GRAFANA_PUBLIC_URL=https://gate.callerwhale.com/staff/monitoring/`,
`CALLERWHALE_AUTH_URL=http://auth:8101`, and
`CALLERWHALE_WEBSITE_URL=https://callerwhale.com`. Supply the Grafana admin password
through Coolify; the built-in account cannot log in through this proxy.

Gateway: `MONITORING_UPSTREAM=http://grafana-proxy:8120`. Remove the Grafana hostname
from `ROUTES`. Landing web: `VITE_CALLERWHALE_GATEWAY_URL=https://gate.callerwhale.com`. Redeploy these components,
verify staff/MFA access and rejection without a session, then remove the old Grafana
Coolify domain and DNS record. DNS removal alone does not remove a public host route.

Keep Grafana's existing data volume when migrating an existing installation. Do not
replace or delete volumes to change routing. Test WebSocket `/api/live/` through the
new prefix as well as assets and dashboards before considering the routing cutover complete.

## What Grafana watches

The same resource also runs the collectors, all on its private network (no public address, nothing published):

| Service | What it does |
|---|---|
| `prometheus` | Collects and keeps 30 days of numbers, every 15 seconds (`prometheus/prometheus.yml`). |
| `node-exporter` | The server: CPU, memory, disk, network, load, uptime. |
| `cadvisor` | Every container on the server: CPU, memory, network and disk use of each one. It mounts the host's `/`, `/sys` and Docker folders read-only and runs privileged, which is how it sees the other containers. |
| `blackbox` | Asks each Caller Whale service (gateway, auth, authz, billing, notifications, the Grafana proxy) and the public website and sign-in address whether they answer, how fast, and when the certificate expires. |
| `loki` | Keeps every container's log lines for 14 days (`loki/loki.yml`). |
| `alloy` | Reads each container's output from Docker (the socket is mounted read-only) and sends it to Loki, labelled by container. |

Grafana is built with its data source and four dashboards inside the image (`grafana/`): **Server health and use**, **Containers: what each one uses**, **Caller Whale services: up or down** and **Service traffic: who called what** (every request each service logged, refusals and errors, slowest addresses). They appear under the folder "Caller Whale". To change one, edit its JSON in `grafana/dashboards`, push, and redeploy this resource.

The services are probed by their private names on the shared Coolify network (`gateway:8100`, `auth:8101`, `authz:8104`, `billing:8103`, `notifications:8102`, `grafana-proxy:8120`). If a name does not resolve (the app has no network alias with that name), that service shows as down; add the alias in Coolify or change the address in `prometheus/prometheus.yml`.

## Alerts (build step 42)

Grafana's alert rules, contact points and night hold are built into the image (`grafana/provisioning/alerting/alerts.yml`, written by `node deploy/grafana/alerts.mjs`; change the rules there). They appear under Alerting, folder "Caller Whale alerts".

| Alert | When | Who |
|---|---|---|
| A service calls, texts or sign-in need is down (gateway, auth, crm-core, dialer) | not answering for 2 minutes | on call, at once |
| The website or sign-in address is down | 3 minutes | on call, at once |
| Sign-in, calls or texts failing | more than 5 (sign-in) or 3 (calls, texts) server errors in 5 minutes | on call, at once |
| Another service down, chats failing, many server errors, disk or memory almost full, a certificate expiring | as named | both, held from 22:00 to 07:00 Paris time |
| Speed targets (D302): opening a lead or list over 1 s, saving a change or sending a text or call outcome over 0.5 s, for one person in four, over 15 minutes | 15 minutes | both, held at night |
| The web app erroring: more than 30 browser errors in 15 minutes | — | both, held at night |

Grafana sends each alert to `alert-relay` (`services/alert-relay`), which pushes it with ntfy (open source; an app on each phone): urgent ones to whoever is on call this week (`ONCALL_ORDER`, a week each from `ONCALL_FROM`), and to the other person when that push fails; routine ones to both. Each push opens Grafana's alert list. It also answers `GET /probes` on the platform network (alias `alert-relay`): whether each service answers its health check, read from Prometheus (which stays on this resource's private network), for auth's public status page. Setup: install the ntfy app, each person subscribes to a long random topic of their own (it is the secret), and put both in `PUSH_TARGETS`; set `RELAY_TOKEN`.

The probes now also cover crm-core, the dialer, messaging, the assistant and the relay. Databases are watched through the services that use them (each `/healthz` checks its database), the containers' use (cAdvisor) and the disk.

Errors in people's browsers (the website and the CRM web app) arrive in the auth service's log as `client_error` lines, with the error's kind, the page without ids, where in the code and the version; never the error's text (D303). Find them in Explore with `{container=~".+"} |= "client_error"`.
