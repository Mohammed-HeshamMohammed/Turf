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

Grafana is built with its data source and three dashboards inside the image (`grafana/`): **Server health and use**, **Containers: what each one uses** and **Caller Whale services: up or down**. They appear under the folder "Caller Whale". To change one, edit its JSON in `grafana/dashboards`, push, and redeploy this resource.

The services are probed by their private names on the shared Coolify network (`gateway:8100`, `auth:8101`, `authz:8104`, `billing:8103`, `notifications:8102`, `grafana-proxy:8120`). If a name does not resolve (the app has no network alias with that name), that service shows as down; add the alias in Coolify or change the address in `prometheus/prometheus.yml`.
