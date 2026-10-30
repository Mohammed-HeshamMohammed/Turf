# Grafana on Coolify

Grafana for Caller Whale's staff, behind the Caller Whale login proxy ([services/grafana-proxy](../../services/grafana-proxy/README.md)). The plan and its progress are in [docs/plans/grafana-access.md](../../docs/plans/grafana-access.md).

`compose.yml` runs two containers in one Coolify resource:

```
browser ──► Coolify's Traefik ──► grafana-proxy (domain, 172.30.10.10)
                                       │ asks the core API: GET /api/v1/platform/whoami
                                       ▼
                                   grafana (no domain, no port, 172.30.10.20)
```

Grafana trusts the `X-WEBAUTH-*` headers only from `172.30.10.10`. Its login form, basic sign-in, anonymous access and sign-up are off, so anything else that reaches it lets nobody in.

## Setting it up in Coolify

1. **New resource → Docker Compose**, from this repository's `grafana-production` branch. It holds only Grafana's files, at the same paths, so the base directory is `/` and the compose file is `deploy/grafana/compose.yml`. From `main` instead, use the base directory `/Full CRM Turf`.
   - Don't use Coolify's one-click Grafana service. It gives Grafana a domain and a login form.
2. **Domains:** set one on `grafana-proxy` only, `https://grafana.callerwhale.com` (port 8120). It needs its own DNS record: in Cloudflare, zone `callerwhale.com`, an A record `grafana` to `187.7.72.171`, DNS only (grey cloud), like `app`. Remove the `www.` copy Coolify adds. Leave `grafana` empty.
3. **Environment variables** (Coolify lists them from the compose file):
   - `CALLERWHALE_CORE_API_URL`
   - `CALLERWHALE_WEBSITE_URL`
   - `GRAFANA_PUBLIC_URL` (the domain from step 2)
   - `GRAFANA_ADMIN_PASSWORD` (a long random secret)
   - optionally `ADMIN_GRAFANA_ROLE` (`Editor` by default)

   See [.env.example](.env.example).
4. **On the core API**, set `CALLERWHALE_GRAFANA_URL` to the same domain and redeploy it. On the website (landing-web), set the runtime variable `GRAFANA_ORIGIN` to the same address and redeploy it. The admin page then has a Grafana panel that shows it in a frame, and the website may frame that address and post a sign-in to it. Visiting the address directly shows only "Open Grafana from the admin dashboard".
5. **Deploy.** The volume `grafana-data` keeps dashboards across deploys.

**Nobody is a Grafana server admin, by design.** The platform owner is `Admin` of Caller Whale's Grafana organization: dashboards, data sources, alerting and the organization's users. The server-wide jobs are done in this file instead:
- Plugins go in `GRAFANA_PLUGINS` (installed at start).
- There's only one organization (`GF_USERS_ALLOW_ORG_CREATE` is off).

Grafana's built-in `admin` account can't be used either: with the login form and basic auth off, it has no way in. This was checked against Grafana 13.2.5.

## Checks after deploying

- Opening the domain without signing in goes to the admin page on callerwhale.com, then back into Grafana.
- A customer, even a workspace owner, gets "Grafana is for Caller Whale's staff".
- `curl -H "X-WEBAUTH-USER: anyone" https://grafana.callerwhale.com/api/user` returns 401. The proxy drops the header, and there's no session.
- Grafana can't be reached at any other address. It has no domain, and `docker ps` shows no published port for it.
- Removing a system administrator in the admin dashboard locks them out of Grafana within `RECHECK_EVERY`.

## If 172.30.10.0/24 is taken on the server

Pick another free subnet. Change the subnet and the three addresses that use it together: `ipv4_address` for both services, `GRAFANA_URL`, and `GF_AUTH_PROXY_WHITELIST`.
