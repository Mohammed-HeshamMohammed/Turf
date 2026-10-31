# Private Grafana in Dashboard admin mode

Grafana has no public hostname or published port. The gateway on `gate.callerwhale.com`
proxies `/staff/monitoring/` to `http://grafana-proxy:8120`. The proxy alone reaches
Grafana on its isolated network. Auth issues the token and handles all MFA methods;
the core API verifies the token and staff role. Every forwarded monitoring request
rechecks access. Sessions expire on inactivity and closure of the panel logs out.

Deploy `deploy/grafana/compose.yml` from `grafana-production` as a Git Docker Compose
application (build context is required). Do not assign a domain to either component.
Attach the proxy to the gateway's Coolify network (`COOLIFY_NETWORK`, default `coolify`).
Set `GRAFANA_PUBLIC_URL=https://gate.callerwhale.com/staff/monitoring/`,
`CALLERWHALE_CORE_API_URL=http://core-api:8088`, and
`CALLERWHALE_WEBSITE_URL=https://callerwhale.com`. Supply the Grafana admin password
through Coolify; the built-in account cannot log in through this proxy.

Gateway: `MONITORING_UPSTREAM=http://grafana-proxy:8120`. Remove the Grafana hostname
from `ROUTES`. Core API: `CALLERWHALE_GRAFANA_URL=https://gate.callerwhale.com/staff/monitoring`.
Landing web: `GRAFANA_ORIGIN=https://gate.callerwhale.com`. Redeploy these components,
verify staff/MFA access and rejection without a session, then remove the old Grafana
Coolify domain and DNS record. DNS removal alone does not remove a public host route.

Keep Grafana's existing data volume when migrating an existing installation. Do not
replace or delete volumes to change routing. Test WebSocket `/api/live/` through the
new prefix as well as assets and dashboards before considering migration complete.
