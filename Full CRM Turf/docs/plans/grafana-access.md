# Grafana behind Turf's platform roles

**Status:** Draft, not started (2026-10-28). Grafana stays private (no domain in Coolify) until steps 1 to 6 below pass.
**Owner of the decision:** the platform owner.

## The issue

Grafana should open only for Turf's own staff: the platform **owner** and the **system administrators** (`users.platform_role` = `owner` or `admin` in the core API). Grafana can't use those roles by itself:

- Turf has no OAuth/OpenID provider that Grafana could sign in with. Auth issues tokens to Turf's own apps, and sign-in is moving to Firebase ([firebase-auth.md](firebase-auth.md)). Neither tells Grafana anyone's platform role.
- The platform role lives only in the core API's database, not in the token.
- Turf's apps keep the token in the page and send it as `Authorization: Bearer`. There's no cookie a browser would carry to another site.

Grafana does support **proxy authentication** (`[auth.proxy]`): a trusted proxy in front of it says who the person is in a header, and Grafana believes it. So the plan is a small login proxy that asks the core API whether the person is staff, and only then lets them through.

## What we already have (findings)

| Finding | Where | What it means for this plan |
| --- | --- | --- |
| Grafana isn't in the repo: not in `deploy/compose.yml`, not in `infra/k8s`, no config | repository search | We add Grafana and its proxy from scratch. Nothing to migrate. |
| `staff()` allows only `owner` or `admin`, **and** requires the authenticator step (`mfa_passed`) whatever `TURF_REQUIRE_MFA` says | `services/core-api/rust/crates/api/src/routes/platform.rs` | The rule we need already exists and is tested (`tests/platform.rs`). The proxy should reuse it, not copy it. |
| `GET /api/v1/me` returns `platform_role` and `platform_admin` | `routes/identity.rs` | Close, but it answers people who skipped MFA too. Not enough alone. |
| Only the owning database role can set a platform role, and there's only one owner | migration `0010_platform_roles.sql` | Nobody can make themselves Grafana admin through the API. |
| Changes made by staff are logged in `platform_events` | `routes/platform.rs` | Grafana sign-ins can be logged the same way. |
| The public gateway is Go (`services/gateway`) and only routes to named upstreams | `services/gateway/main.go`, `deploy/compose.yml` | Grafana must **not** be added to the gateway's `UPSTREAMS`. The proxy is its own way in. |
| Sign-in is moving from `services/auth` (Ed25519) to Firebase (RS256); the core API accepts both while the move runs | `docs/plans/firebase-auth.md` | If the proxy asks the core API instead of reading tokens itself, it keeps working through the move with no change. |

## The design

```
browser ──► grafana-proxy (public, TLS) ──► Grafana (private network only)
               │
               └──► core API  GET /api/v1/platform/whoami   (Bearer token)
```

1. **New endpoint in the core API: `GET /api/v1/platform/whoami`.** It runs `staff()` and returns `{ id, email, name, role }` with 200. Someone who isn't staff gets 403. Staff who haven't passed MFA get the usual MFA-required error. It needs no `x-turf-org` header. One line of logic, and the rule stays in one place.
2. **New service `services/grafana-proxy` (Go, same style as the gateway).**
   - Without a valid session it sends the browser to the website's admin dashboard: `/#/admin/grafana?return=<path>`.
   - The website is already signed in and has the token. It POSTs the token once to the proxy's `/_turf/session` (same-site form post, so the token never goes in a URL).
   - The proxy calls `whoami` with that token. On 200 it sets **its own** cookie: HttpOnly, Secure, SameSite=Strict, signed with a proxy secret, lasting 15 minutes. It never stores the Turf token.
   - It sends each request on to Grafana with `X-WEBAUTH-USER` (the Turf user id), `X-WEBAUTH-EMAIL`, `X-WEBAUTH-NAME` and `X-WEBAUTH-ROLE`. It removes any of those headers the browser sent.
   - **Re-check:** within the 15 minutes the proxy re-asks `whoami` at most once a minute, using a token the website refreshes in the background. If the answer is 403, it drops the session at once. So a demoted admin is out within a minute, and a staff member whose access was turned off is out at once on the next check.
   - `/_turf/logout` clears the cookie.
3. **Grafana settings**, set as environment variables in Coolify:
   - `GF_AUTH_PROXY_ENABLED=true`, `GF_AUTH_PROXY_HEADER_NAME=X-WEBAUTH-USER`, `GF_AUTH_PROXY_HEADER_PROPERTY=username`, `GF_AUTH_PROXY_AUTO_SIGN_UP=true`, `GF_AUTH_PROXY_HEADERS=Email:X-WEBAUTH-EMAIL Name:X-WEBAUTH-NAME Role:X-WEBAUTH-ROLE`, and `GF_AUTH_PROXY_WHITELIST=<the proxy's fixed IP>`.
   - `GF_AUTH_DISABLE_LOGIN_FORM=true`, `GF_AUTH_BASIC_ENABLED=false`, `GF_AUTH_ANONYMOUS_ENABLED=false`, `GF_USERS_ALLOW_SIGN_UP=false`.
   - `GF_SERVER_ROOT_URL=https://<grafana domain>`, set to the proxy's domain.
   - Grafana has no domain in Coolify. Only the proxy can reach it (see "Running it on Coolify").
4. **Role mapping** (to confirm, see Decisions):

   | Turf platform role | Grafana role |
   | --- | --- |
   | `owner` | `Admin` (and Grafana server admin, set once by hand) |
   | `admin` | `Editor` |
   | anyone else | no entry: the proxy refuses before Grafana is reached |

## Running it on Coolify

Turf is deployed with Coolify. Grafana runs in its own container, next to the proxy's container.

**One Coolify resource of type Docker Compose holds both containers**, from `deploy/grafana/compose.yml`:

```
Coolify's Traefik ──► grafana-proxy   (has the domain, e.g. grafana.<domain>)
                          │  private compose network, fixed subnet
                          ▼
                       grafana        (no domain, no published port)
```

Why one compose resource rather than two separate apps:

- **A private network for free.** Containers in one Coolify compose resource share their own network. In separate resources Grafana would have to join Coolify's shared `coolify` network ("Connect to Predefined Network"), which every other app on the server can reach too.
- **A fixed proxy IP.** Grafana's whitelist takes IP addresses, not container names. The compose file gives the network a fixed subnet and the proxy a fixed address, for example `172.30.10.10`, and `GF_AUTH_PROXY_WHITELIST` is set to that address.
- **Two locks.** If Grafana is ever given a domain by mistake, Traefik's requests come from Traefik's own IP and not the whitelisted one, so Grafana ignores the `X-WEBAUTH-*` headers. It then shows its disabled login form and lets nobody in.

Coolify rules for this resource:

- **Don't use Coolify's one-click Grafana template.** It gives Grafana a domain and a login form. Use our compose file instead.
- In Coolify, set a domain only on the `grafana-proxy` service. Leave `grafana` blank, and put no `ports:` entry on it.
- Keep secrets in the resource's environment variables in Coolify, never in the repo:
  - the proxy's cookie-signing key
  - Grafana's admin password (`GF_SECURITY_ADMIN_PASSWORD`)
  - the core API's address (`TURF_CORE_API_URL`)
- Give Grafana's data folder (`/var/lib/grafana`) a persistent volume so dashboards survive redeploys.
- The proxy reaches the core API at its public address (or at its container name, if the core API is put on the same network later).
- Health checks: the proxy answers `GET /_turf/health`, and Grafana answers `GET /api/health` (checked from inside the network only).

## Steps and progress

Mark each step when it is merged and checked.

- [x] **1. `whoami` endpoint** (done 2026-10-28) in the core API, with tests in `tests/platform.rs`: owner returns 200 owner, admin returns 200 admin, staff without MFA are refused, a customer workspace owner gets 403, no token gets 401. Add it to `contracts/api-v1.yaml`.
- [ ] **2. `services/grafana-proxy`**: session post, signed cookie, header stripping, re-check, logout. Go tests against a fake core API and a fake Grafana. The fakes cover expired cookie, forged cookie, forged `X-WEBAUTH-*` headers, a 403 on re-check, and a core API that's down (fail closed).
- [ ] **3. Website handoff**: the `/#/admin/grafana` route in `services/core-api/website/app.js` (posts the token, then follows `return`), plus a "Grafana" link in the admin dashboard for staff only. Add the proxy's origin to the website's `form-action` CSP.
- [ ] **4. Compose file and local check**: write `deploy/grafana/compose.yml` (Grafana and the proxy, fixed subnet, Grafana not published). It's the same file Coolify will use. Run it locally against the local core API and check by hand:
  - the owner gets in as Admin
  - an admin gets in as Editor
  - a customer owner is refused
  - removing an admin locks them out within a minute
  - calling Grafana directly is refused
- [ ] **5. Coolify**: create the Docker Compose resource from `deploy/grafana/compose.yml`. Set the domain on the proxy only, add the secrets as environment variables, and add the volume. Then check from outside:
  - Grafana can't be reached directly.
  - Sending a forged `X-WEBAUTH-USER` to the proxy's domain changes nothing.
  - The owner and an admin get in, with their right roles.

  (`infra/k8s` is used only if Turf moves off Coolify.)
- [ ] **6. Audit**: log each Grafana sign-in in `platform_events` (`grafana.sign_in`), so it shows up in the Activity tab.
- [ ] **7. Open Grafana's address** only after 1 to 6 are done.

## Decisions to make

- **Grafana role for system administrators:** Editor (can change dashboards) or Viewer (look only)? The plan assumes Editor.
- **Where Grafana's address lives:** its own subdomain (`grafana.<domain>`) or under the admin site (`/grafana/`)? A subdomain keeps Grafana's cookies apart from the website's. The plan assumes a subdomain.
- **Re-check interval:** 60 seconds assumed. Shorter means more calls to the core API.

## Out of scope

- Customer-facing dashboards. Workspace owners keep the reports inside Turf. Grafana is for Turf's staff only.
- Giving Turf a full OpenID provider. If more internal tools need staff sign-in later, that's the time to revisit it, and the proxy can then be retired.

## Log

- 2026-10-28: Plan written. Findings gathered: Grafana isn't in the repo yet; `staff()` with MFA exists and is tested; `/me` exposes the platform role but doesn't require MFA; sign-in is moving to Firebase, which is why the proxy asks the core API instead of checking tokens itself.
- 2026-10-28: Deployment is Coolify, with Grafana in its own container. The plan now uses one Coolify Docker Compose resource for Grafana and the proxy. Only the proxy has a domain, Grafana trusts only the proxy's fixed IP, and step 5 is Coolify instead of Kubernetes.
- 2026-10-28: Step 1 done. `GET /api/v1/platform/whoami` reuses `staff()` and answers `{ id, email, name, role }`. Test `whoami_answers_only_for_staff` covers owner, admin, no organization, customer owner (403), no token (401), staff without MFA (`mfa_required`), a turned-off admin, and a removed admin (403). Along the way, the contract test was found to skip `billing.rs` and `platform.rs`; it now scans both, and their 17 routes are in `contracts/api-v1.yaml`.
