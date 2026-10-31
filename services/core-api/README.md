# Core API (the existing Caller Whale server)

> Moved here unchanged from `backend/` and `website/` (2026-10-27, history kept). It is still one program: the CRM, billing, sync and the website together. **It has no sign-in of its own:** accounts, passwords, two-step sign-in, Google and Apple, email confirmation and sessions live only in the auth service (`services/auth`). Every request carries an auth access token (`Authorization: Bearer`) and the organization it acts in (`x-callerwhale-org`); the API checks the token with auth's public keys and refuses to start without them (`CALLERWHALE_AUTH_JWKS`, or `CALLERWHALE_AUTH_JWKS_URL` to fetch them at start). There are no cookies, so there is no CSRF header and CORS allows no credentials. Removing someone from an organization ends their access there at once, because every request reads their membership. The workspace half of joining stays here: `POST /api/v1/organizations/trial` opens a trial organization for the signed-in person, `POST /api/v1/invitations/join` joins an invitation's organization (the invitation must be for their email), and a person auth vouches for gets their copy here (same id, no usable password) on their first request. `GET /api/v1/auth/service` tells the website where auth is (`CALLERWHALE_AUTH_PUBLIC_URL`, default `http://localhost:8101`), and the website's Content Security Policy allows requests to that address and nowhere else. The live-updates socket (`/events`) takes the token in its subprotocol list (`callerwhale.v1`, `bearer.<token>`, `org.<id>`), since a browser cannot add headers to a WebSocket. Splitting the CRM out into `services/features/crm` comes later.

> **Sign-in.** The API checks only the auth service's tokens (`CALLERWHALE_AUTH_JWKS` or `CALLERWHALE_AUTH_JWKS_URL`). It knows nothing about Firebase: the auth service is the only part that does (`docs/plans/firebase-auth.md`).

> **How people sign in.** Every token carries `provider` ("password", "google", "apple"; the auth service records it on each session). The API keeps the last one in `users.sign_in_provider` and returns it as `sign_in` on `/me`, the directory, the team page's members and the admin People and Staff lists; the apps show it as the provider's mark (`SignInMark` in the CRM, `signInMark` on the website). Someone who has not made a request since this was added has none, and shows no mark. The API starts with either key set, or both while sign-in moves. With `CALLERWHALE_FIREBASE_API_KEY` and `CALLERWHALE_FIREBASE_APP_ID` too (and optionally `CALLERWHALE_FIREBASE_AUTH_DOMAIN`, default `<project>.firebaseapp.com`, and `CALLERWHALE_FIREBASE_PROVIDERS`, default `google`), `GET /api/v1/auth/service` hands the website its Firebase web config, and the website signs in with Firebase. Its Content Security Policy then also allows Firebase's two sign-in APIs, Google's sign-in script (`https://apis.google.com`) and the project's sign-in frame, and nothing else.

The server side of the full CRM (see `docs/CALLERWHALE_CRM_AND_PERFORMANCE_PLAN.md`). The desktop app's local Skip Tracing service stays in `service/`.

(Paths below are relative to `Caller Whale CRM/`. This service is `services/core-api/`; the shared `contracts/` and `docs/saas/` stay at the top of `Caller Whale CRM/`.)

| Folder | Language | What it does |
| --- | --- | --- |
| `rust/` | Rust (Axum, sqlx) | Public API, permissions (people sign in with `services/auth`), CRM transactions, sync, WebSocket events, rule execution, legacy import. Owns the PostgreSQL database updates. `crates/grouping` is the deterministic grouping library shared with offline Skip Tracing. |
| `go/` | Go (standard library) | `callerwhale-worker`: claims outbox events and has the API run their rules (one lead's events in order), ticks the scheduler every minute (overdue tasks and handoffs, scheduled reports), and publishes cache invalidations to Redis. Health on `:8090/healthz`. |

Shared contracts (API, events, jobs, native ABIs) live in `contracts/`.

## Local development

### PostgreSQL on Windows (no installer, no admin)

PostgreSQL 17.11 runs from EDB's portable build in `D:\tools\pgsql`, with its data in `D:\callerwhale-data`. `D:\tools\env.sh` puts it on the `PATH`. Delete both folders to remove it. Start it after a restart, from Git Bash:

```bash
CALLERWHALE_TOOLS=/d/tools/env.sh CALLERWHALE_DATA=/d/callerwhale-data bash services/core-api/scripts/dev-services.sh
```

Do not pipe that command into `tail` or `head`: the server it starts keeps the pipe open and the command never returns. Stop the server with `source /d/tools/env.sh && pg_ctl -D /d/callerwhale-data/pg stop`. Redis is not installed; the API and its tests run without it (the cache is off).

Run every test, including the end-to-end ones against the database:

```bash
cd services/core-api/rust && TEST_DATABASE_URL=postgres://callerwhale_api:callerwhale_api@127.0.0.1:55432/callerwhale_test TEST_DATABASE_SETUP_URL=postgres://callerwhale_owner:callerwhale_owner@127.0.0.1:55432/callerwhale_test cargo test --workspace -- --test-threads=1
```

The auth service has its own login and databases on the same server: `callerwhale_auth` (password `callerwhale_auth`) owns `callerwhale_auth` and `callerwhale_auth_test`.


```bash
bash services/core-api/scripts/dev-services.sh
```

This starts PostgreSQL and Redis with their data in `X:\callerwhale-data` (set `CALLERWHALE_DATA` to change it), creates the roles and prints the connection URLs. Two roles matter:

- `callerwhale_owner` owns the schema and runs database updates.
- `callerwhale_api` is the API's login, a member of `callerwhale_app`. Row security always applies to it, so one organization can never read another's rows.

Run the API:

```bash
node tools/env-init.mjs                       # once, from Caller Whale CRM/: env/core-api.env, env/worker.env, ... with new secrets
bash services/core-api/scripts/run-api.sh     # reads env/core-api.env; start the auth service first
```

Every setting and secret (database, worker tokens, webhook secret, auth) is in `env/core-api.env`; `env/README.md` lists them. A variable already set in the environment wins over the file.

Tests (unit, contract, and end to end against the real database):

```bash
cd services/core-api/rust && TEST_DATABASE_URL=postgres://callerwhale_api:callerwhale_api@127.0.0.1:55432/callerwhale_test TEST_DATABASE_SETUP_URL=postgres://callerwhale_owner:callerwhale_owner@127.0.0.1:55432/callerwhale_test TEST_REDIS_URL=redis://127.0.0.1:56379 cargo test --workspace
```

Without `TEST_DATABASE_URL` the end-to-end tests skip themselves. The tests play the auth service's part: the harness holds a test signing key, gives the API its public half, and signs tokens for the people each test needs.

The old sign-in tables (`sessions`, `oauth_states`, `oauth_handoffs`, `email_verifications`, `user_identities`, `recovery_codes`, and the password and two-step columns of `users`) are no longer read or written. They stay, untouched, until the copy into auth (`services/auth/scripts/import-from-core-api.sh`) has been confirmed on the production server; a later database update drops them.

### The whole stack, with the CRM interface

```bash
# the auth service first, on http://127.0.0.1:8101 with AUTH_DEV_TOKENS=true (see services/auth/README.md)
bash services/core-api/scripts/run-api.sh          # API on http://127.0.0.1:8088 (starts PostgreSQL and Redis too)
bash services/core-api/scripts/run-worker.sh       # Go worker
python services/core-api/scripts/dev_seed.py       # once, on a fresh database: an organization, one person per role, sample leads
```

`dev_seed.py` makes the accounts at auth, then the organization and memberships here, and writes the local test accounts to `services/core-api/scripts/.dev-accounts.json` (git-ignored). In the CRM interface (`desktop/frontend/react`, `npm run dev`), sign in with one of them; the CRM signs in at auth and talks to `http://localhost:8088`. Owners and administrators need an authenticator code.

Records then come from the server. Changes apply on screen at once and queue as operations; offline they wait in an encrypted IndexedDB copy unlocked by a passphrase. On reconnect, a change someone else made meanwhile shows on the Sync page with both values.

## Who runs Caller Whale: the admin dashboard

Caller Whale's own people have a platform role (`users.platform_role`, database update `0010_platform_roles.sql`):

- **Platform owner**: the owner of the app. There is exactly one, set once on the server with `python services/core-api/scripts/create_platform_owner.py <email>` after that person has signed in with auth and opened Caller Whale once. The script refuses a second owner.
- **System administrators**: named and removed only by the owner, from the dashboard.

Nobody gets either role by signing up, by an invitation or through any customer page, and the database itself refuses a platform role from the API's login (a trigger, and `callerwhale_platform_set_role`, which only the owner can use and which can never give the owner role). Inside a customer's workspace the highest role is the **business owner**, the person who opened it: there is no "System administrator" role there any more, the owner role cannot be given or taken, and no other role may manage members and access. Existing workspace administrators became team managers.

The dashboard is on the website at `/#/admin` (an **Admin** button appears for staff). Its API is `/api/v1/platform/*`:

| Tab | Staff | Owner only |
| --- | --- | --- |
| Overview | Totals, newest workspaces, latest staff activity | |
| Workspaces | Open a workspace for a customer (a trial, with a link that makes them its owner); every workspace's plan, minutes, seats, payments; suspend or reactivate; extend by 7 or 30 days | Set any plan and seats without a payment; remove all limits |
| Payments | Every payment across workspaces, with paid, waiting, failed and refunded totals | |
| People | Search everyone; turn a customer's access off or on | Turn another administrator's access off |
| Staff | See Caller Whale's staff | Name or remove system administrators |
| Activity | Every change made from the dashboard (`platform_events`) | |
| My workspace | Open a workspace of Caller Whale's own with no plan, so no seat, minute or time limit, for as many callers and CRM users as needed | |

Customer records are never shown. A suspended workspace refuses everything until reactivated; turning someone's access off refuses them on this server (auth still knows the account). Staff always need the authenticator code, whatever `CALLERWHALE_REQUIRE_MFA` says.

**Who gets in.** Only people given access: an account at auth opens nothing here by itself. Staff open a customer's workspace and send its owner the link (`POST /api/v1/platform/customers`); the owner invites everyone else, with an end date if they like. Members whose access ends, or is removed, lose the workspace at once, and the desktop app erases that workspace's offline copy at its next check. `CALLERWHALE_PUBLIC_SIGNUP=true` lets new accounts open their own trial again (off by default).


**Desktop access by invitation** (`routes/desktop_access.rs`, database update `0014_desktop_access.sql`, plan [docs/plans/callerwhale-launch.md](../../docs/plans/callerwhale-launch.md)). Staff invite a person by email with a monthly credit limit (`/api/v1/platform/invitations`); the email goes out through Caller Whale's mail server (`CALLERWHALE_SMTP_*`). The person signs in on the website with that email, confirmed, and `GET /api/v1/account` activates the invitation: a workspace of their own, their credits and usage, and a 10-minute download link for the newest `crm-v*` release (`POST /api/v1/account/download`). The desktop app spends credits with `POST /api/v1/credits/use` before Skip Tracing, and is refused when the month's are used up. Staff change limits, suspend (the account is refused at once), reactivate, resend and withdraw; every change is in `platform_events`.

**Grafana.** With `CALLERWHALE_GRAFANA_URL` set to the Grafana login proxy (`services/grafana-proxy`), the dashboard shows an **Open Grafana** button, and `GET /api/v1/auth/service` returns the address as `grafana`. `#/admin/grafana` posts the signed-in person's token to the proxy in a form, so it never goes in a URL. The website's `form-action` then allows that one address too. The proxy checks the token with `GET /api/v1/platform/whoami`, which answers only for staff who passed the authenticator step. Plan: [docs/plans/grafana-access.md](../../docs/plans/grafana-access.md).

## How a change flows

Every CRM write is an operation (`POST /api/v1/ops`, or many at once through `/sync/push`) with a client-chosen id, so a replay gets the first answer back. In one transaction, an operation checks the person's capability and record scope, applies its change, and writes four things: an audit event, a change-log row for `/sync/pull`, an outbox event for workers and rules, and a `NOTIFY` that becomes a WebSocket message.

Workers never touch the database directly. They claim jobs and outbox events through `/internal` with a worker token, and rule actions run back through the same operations path.

## Paid service

Sign-up, the trial, Solo and Business plans, seats, call minutes, checkout and the payment webhook are described in
[docs/saas/README.md](../../docs/saas/README.md), with the database diagram. The public website (`services/core-api/website/`) is served by
the API when `CALLERWHALE_SITE_DIR` is set (`run-api.sh` sets it).
