# Core API (the existing Turf server)

> Moved here unchanged from `backend/` and `website/` (2026-10-27, history kept). It is still one program: the CRM, billing, sync and the website together. **It has no sign-in of its own:** accounts, passwords, two-step sign-in, Google and Apple, email confirmation and sessions live only in the auth service (`services/auth`). Every request carries an auth access token (`Authorization: Bearer`) and the organization it acts in (`x-turf-org`); the API checks the token with auth's public keys and refuses to start without them (`TURF_AUTH_JWKS`, or `TURF_AUTH_JWKS_URL` to fetch them at start). There are no cookies, so there is no CSRF header and CORS allows no credentials. Removing someone from an organization ends their access there at once, because every request reads their membership. The workspace half of joining stays here: `POST /api/v1/organizations/trial` opens a trial organization for the signed-in person, `POST /api/v1/invitations/join` joins an invitation's organization (the invitation must be for their email), and a person auth vouches for gets their copy here (same id, no usable password) on their first request. `GET /api/v1/auth/service` tells the website where auth is (`TURF_AUTH_PUBLIC_URL`, default `http://localhost:8101`), and the website's Content Security Policy allows requests to that address and nowhere else. The live-updates socket (`/events`) takes the token in its subprotocol list (`turf.v1`, `bearer.<token>`, `org.<id>`), since a browser cannot add headers to a WebSocket. Splitting the CRM out into `services/features/crm` comes later.

The server side of the full CRM (see `docs/TURF_CRM_AND_PERFORMANCE_PLAN.md`). The desktop app's local Skip Tracing service stays in `service/`.

(Paths below are relative to `Full CRM Turf/`. This service is `services/core-api/`; the shared `contracts/` and `docs/saas/` stay at the top of `Full CRM Turf/`.)

| Folder | Language | What it does |
| --- | --- | --- |
| `rust/` | Rust (Axum, sqlx) | Public API, permissions (people sign in with `services/auth`), CRM transactions, sync, WebSocket events, rule execution, legacy import. Owns the PostgreSQL migrations. `crates/grouping` is the deterministic grouping library shared with offline Skip Tracing. |
| `go/` | Go (standard library) | `turf-worker`: claims outbox events and has the API run their rules (one lead's events in order), ticks the scheduler every minute (overdue tasks and handoffs, scheduled reports), and publishes cache invalidations to Redis. Health on `:8090/healthz`. |

Shared contracts (API, events, jobs, native ABIs) live in `contracts/`.

## Local development

### PostgreSQL on Windows (no installer, no admin)

PostgreSQL 17.11 runs from EDB's portable build in `D:\tools\pgsql`, with its data in `D:\turf-data`. `D:\tools\env.sh` puts it on the `PATH`. Delete both folders to remove it. Start it after a restart, from Git Bash:

```bash
TURF_TOOLS=/d/tools/env.sh TURF_DATA=/d/turf-data bash services/core-api/scripts/dev-services.sh
```

Do not pipe that command into `tail` or `head`: the server it starts keeps the pipe open and the command never returns. Stop the server with `source /d/tools/env.sh && pg_ctl -D /d/turf-data/pg stop`. Redis is not installed; the API and its tests run without it (the cache is off).

Run every test, including the end-to-end ones against the database:

```bash
cd services/core-api/rust && TEST_DATABASE_URL=postgres://turf_api:turf_api@127.0.0.1:55432/turf_test TEST_MIGRATION_DATABASE_URL=postgres://turf_owner:turf_owner@127.0.0.1:55432/turf_test cargo test --workspace -- --test-threads=1
```

The auth service has its own login and databases on the same server: `turf_auth` (password `turf_auth`) owns `turf_auth` and `turf_auth_test`.


```bash
bash services/core-api/scripts/dev-services.sh
```

This starts PostgreSQL and Redis with their data in `X:\turf-data` (set `TURF_DATA` to change it), creates the roles and prints the connection URLs. Two roles matter:

- `turf_owner` owns the schema and runs migrations.
- `turf_api` is the API's login, a member of `turf_app`. Row security always applies to it, so one organization can never read another's rows.

Run the API:

```bash
cd services/core-api/rust && DATABASE_URL=postgres://turf_api:turf_api@127.0.0.1:55432/turf MIGRATION_DATABASE_URL=postgres://turf_owner:turf_owner@127.0.0.1:55432/turf REDIS_URL=redis://127.0.0.1:56379 TURF_AUTH_JWKS_URL=http://localhost:8101/.well-known/jwks.json TURF_WORKER_TOKENS=go=change-me-to-a-long-random-token cargo run -p turf-api
```

Tests (unit, contract, and end to end against the real database):

```bash
cd services/core-api/rust && TEST_DATABASE_URL=postgres://turf_api:turf_api@127.0.0.1:55432/turf_test TEST_MIGRATION_DATABASE_URL=postgres://turf_owner:turf_owner@127.0.0.1:55432/turf_test TEST_REDIS_URL=redis://127.0.0.1:56379 cargo test --workspace
```

Without `TEST_DATABASE_URL` the end-to-end tests skip themselves. The tests play the auth service's part: the harness holds a test signing key, gives the API its public half, and signs tokens for the people each test needs.

The old sign-in tables (`sessions`, `oauth_states`, `oauth_handoffs`, `email_verifications`, `user_identities`, `recovery_codes`, and the password and two-step columns of `users`) are no longer read or written. They stay, untouched, until the copy into auth (`services/auth/scripts/import-from-core-api.sh`) has been confirmed on the production server; a later migration drops them.

### The whole stack, with the CRM interface

```bash
# the auth service first, on http://127.0.0.1:8101 with AUTH_DEV_TOKENS=true (see services/auth/README.md)
bash services/core-api/scripts/run-api.sh          # API on http://127.0.0.1:8088 (starts PostgreSQL and Redis too)
bash services/core-api/scripts/run-worker.sh       # Go worker
python services/core-api/scripts/dev_seed.py       # once, on a fresh database: an organization, one person per role, sample leads
```

`dev_seed.py` makes the accounts at auth, then the organization and memberships here, and writes the local test accounts to `services/core-api/scripts/.dev-accounts.json` (git-ignored). In the CRM interface (`desktop/frontend/react`, `npm run dev`), sign in with one of them; the CRM signs in at auth and talks to `http://localhost:8088`. Owners and administrators need an authenticator code.

`create_platform_admin.py <email>` promotes someone who has already signed in with auth and opened the CRM once. Records then come from the server. Changes apply on screen at once and queue as operations; offline they wait in an encrypted IndexedDB copy unlocked by a passphrase. On reconnect, a change someone else made meanwhile shows on the Sync page with both values.

## How a change flows

Every CRM write is an operation (`POST /api/v1/ops`, or many at once through `/sync/push`) with a client-chosen id, so a replay gets the first answer back. In one transaction, an operation checks the person's capability and record scope, applies its change, and writes four things: an audit event, a change-log row for `/sync/pull`, an outbox event for workers and rules, and a `NOTIFY` that becomes a WebSocket message.

Workers never touch the database directly. They claim jobs and outbox events through `/internal` with a worker token, and rule actions run back through the same operations path.

## Paid service

Sign-up, the trial, Solo and Business plans, seats, call minutes, checkout and the payment webhook are described in
[docs/saas/README.md](../../docs/saas/README.md), with the database diagram. The public website (`services/core-api/website/`) is served by
the API when `TURF_SITE_DIR` is set (`run-api.sh` sets it).
