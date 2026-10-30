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
   - Without a valid session it sends the browser to the website's `/admin/grafana?return=<path>` (the landing site).
   - The website is already signed in and has the token. It POSTs the token once to the proxy's `/_turf/session` (same-site form post, so the token never goes in a URL).
   - The proxy calls `whoami` with that token. On 200 it sets **its own** cookie, `turf_grafana`: a random 256-bit session id, HttpOnly, Secure, SameSite=Lax (Strict would drop it on the redirect that follows the website's post). The Turf token stays in the proxy's memory only, never in the cookie, and is used for the re-checks. A session lasts at most `SESSION_MAX_AGE` (8 hours), and in practice ends sooner, when the token expires.
   - A token without the authenticator step gets a "sign in again" page, not a redirect: the website would post the same token again, in a loop.
   - It sends each request on to Grafana with `X-WEBAUTH-USER` (the Turf user id), `X-WEBAUTH-EMAIL`, `X-WEBAUTH-NAME` and `X-WEBAUTH-ROLE`. It removes any of those headers the browser sent.
   - **Re-check:** the proxy re-asks `whoami` at most once a `RECHECK_EVERY` (60 seconds), with the token it keeps. If the answer is 403, it drops the session at once, so a removed or turned-off admin is out within a minute. If the answer is 401 (the token expired), the person goes back to the website, which posts a fresh token and returns them. If the core API can't be reached, nobody gets through.
   - `/_turf/logout` clears the cookie.
3. **Grafana settings**, set as environment variables in Coolify:
   - `GF_AUTH_PROXY_ENABLED=true`, `GF_AUTH_PROXY_HEADER_NAME=X-WEBAUTH-USER`, `GF_AUTH_PROXY_HEADER_PROPERTY=username`, `GF_AUTH_PROXY_AUTO_SIGN_UP=true`, `GF_AUTH_PROXY_HEADERS=Email:X-WEBAUTH-EMAIL Name:X-WEBAUTH-NAME Role:X-WEBAUTH-ROLE`, and `GF_AUTH_PROXY_WHITELIST=<the proxy's fixed IP>`.
   - `GF_AUTH_DISABLE_LOGIN_FORM=true`, `GF_AUTH_BASIC_ENABLED=false`, `GF_AUTH_ANONYMOUS_ENABLED=false`, `GF_USERS_ALLOW_SIGN_UP=false`.
   - `GF_SERVER_ROOT_URL=https://<grafana domain>`, set to the proxy's domain.
   - Grafana has no domain in Coolify. Only the proxy can reach it (see "Running it on Coolify").
4. **Role mapping** (to confirm, see Decisions):

   | Turf platform role | Grafana role |
   | --- | --- |
   | `owner` | `Admin` of Turf's Grafana organization. Nobody is a Grafana server admin; plugins come from `GRAFANA_PLUGINS` in the compose file |
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
  - Grafana's admin password (`GF_SECURITY_ADMIN_PASSWORD`)
  - the core API's address (`TURF_CORE_API_URL`)
- Give Grafana's data folder (`/var/lib/grafana`) a persistent volume so dashboards survive redeploys.
- The proxy reaches the core API at its public address (or at its container name, if the core API is put on the same network later).
- Health checks: the proxy answers `GET /_turf/health`, and Grafana answers `GET /api/health` (checked from inside the network only).

## Steps and progress

Mark each step when it is merged and checked.

- [x] **1. `whoami` endpoint** (done 2026-10-28) in the core API, with tests in `tests/platform.rs`: owner returns 200 owner, admin returns 200 admin, staff without MFA are refused, a customer workspace owner gets 403, no token gets 401. Add it to `contracts/api-v1.yaml`.
- [x] **2. `services/grafana-proxy`** (done 2026-10-28): session post, signed cookie, header stripping, re-check, logout. Go tests against a fake core API and a fake Grafana. The fakes cover expired cookie, forged cookie, forged `X-WEBAUTH-*` headers, a 403 on re-check, and a core API that's down (fail closed).
- [x] **3. Website handoff** (done 2026-10-28): the `/#/admin/grafana` route in `services/core-api/website/app.js` (posts the token, then follows `return`), plus a "Grafana" link in the admin dashboard for staff only. Add the proxy's origin to the website's `form-action` CSP.
- [x] **4. Compose file and local check** (done 2026-10-28, without Docker; see the log): write `deploy/grafana/compose.yml` (Grafana and the proxy, fixed subnet, Grafana not published). It's the same file Coolify will use. Run it locally against the local core API and check by hand:
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
- 2026-10-28: Step 2 done. `services/grafana-proxy` (Go, standard library only) has 15 tests against a fake core API and a fake Grafana, and `go vet` is clean. Changes from the first design: the cookie is a random session id rather than a signed one, so there's no signing key to keep, and the token stays in the proxy's memory for re-checks. SameSite is Lax, not Strict. A sign-in without the authenticator step shows a page instead of looping through the website. The container has a `/service health` command for Coolify, since the image has no curl. It isn't in `tools/stack.json`, because the scaffolder would put it behind the gateway. Go 1.27.3 was installed in `D:\tools\go` to run the tests (it's on the PATH from `D:\tools\env.sh`).
- 2026-10-28: Step 3 done. The core API reads `TURF_GRAFANA_URL` (the proxy's address), returns it as `grafana` from `GET /api/v1/auth/service`, and adds its origin to the website's `form-action`. The admin dashboard shows **Open Grafana** when it's set. `#/admin/grafana` posts the token to the proxy and replaces itself in history, so Back from Grafana lands on the dashboard. Checked in a browser on a scratch stack (auth, core API with website, proxy, and a stand-in Grafana that echoes the headers it gets). The owner signed in with password and authenticator code, and Open Grafana reached Grafana as `Admin` with id, email and name. The proxy's own cookie wasn't passed on. A Grafana deep link without a session went to the website and came back to the same path. Bug found by the browser check: the website's `Referrer-Policy: same-origin` makes a cross-site form post send `Origin: null`, so the proxy refused it. The hand-off page now sets `strict-origin` for itself just before posting, which sends the website's origin and nothing else.
- 2026-10-28: Step 4 done. `deploy/grafana/compose.yml` has Grafana 13.2.5 (`grafana/grafana-oss`) and the proxy on a fixed subnet. Grafana has no ports and trusts only `172.30.10.10`, and the proxy calls Grafana by address so its requests always come from there. `.env.example` and a Coolify README sit next to it. Docker isn't on this machine, so the compose file itself hasn't run yet; its first real run is step 5. Instead, the official Grafana 13.2.5 Windows build was run with exactly the compose file's `GF_*` settings (only addresses, ports and folders changed), against the scratch stack. Results:
  - With Grafana trusting another address, a forged `X-WEBAUTH-USER`/`ROLE: Admin` got 401 ("request ip is not in the configured accept list"). Basic auth as the built-in `admin` got 401, and the login form got 400 ("not configured").
  - Trusting the proxy: the owner clicked Open Grafana in the admin dashboard and landed in real Grafana as their Turf id, with name, email and org role `Admin`.
  - Role headers apply and update: `Editor`, and a later `Viewer`, took effect on the next request.
  - Signing out of Grafana ends the proxy session and lands on Turf's admin dashboard.
  - Decided: nobody is a Grafana server admin. The built-in `admin` has no way in, plugins come from `GRAFANA_PLUGINS`, and there is only one organization. The news feed (which calls grafana.com) is off.
- 2026-10-30: Grafana moved inside the admin page. The admin page (landing site) has a Grafana panel with an iframe; the token is posted to the proxy by a form aimed at that frame. The proxy now (1) turns away a browser visiting its address as a page of its own (`Sec-Fetch-Dest: document`), (2) sends `Content-Security-Policy: frame-ancestors <website origin>` and drops Grafana's `X-Frame-Options`, so only the website may frame it, (3) asks the page around a frame to sign in again (`postMessage`) instead of redirecting into the website, which can't be framed, and (4) answers `/_turf/logout` with a page rather than a redirect. Grafana runs with `GF_SECURITY_ALLOW_EMBEDDING=true`. The landing CSP's `frame-src` includes `GRAFANA_ORIGIN`. Staff still need the authenticator step: `whoami` refuses tokens without it. `/admin/grafana` now just goes to `/admin`. The proxy still needs a DNS name (the browser has to reach it), but it shows nothing to anyone outside the frame.
- 2026-10-30 (later): `/admin` and `/admin/grafana` are gone from the landing site (routes, prerendered pages, nginx location, header link, sign-in `next`); they answer with the site's 404. Staff sign in to `/dashboard`, where **Admin mode** holds the invitations and the Grafana frame. Admin mode lives only in the page's memory (no address, nothing stored): a reload or closed tab ends it, and ten idle minutes ends it (activity in the page, or focus inside the Grafana frame, counts). It starts only from a sign-in at most 15 minutes old (the token's `auth_time`; the authenticator code is part of that sign-in), otherwise the page asks the person to sign in again. The proxy enforces the same on its side: `AUTH_WITHIN` (15m) refuses an older or time-less token, `IDLE_TIMEOUT` (10m) ends a session with no requests, and `SESSION_MAX_AGE` drops from 8h to 1h. Visits without a session now get a 401 page instead of a redirect to the website. The old website at `app.callerwhale.com` lost its Open Grafana button and hand-off route.
