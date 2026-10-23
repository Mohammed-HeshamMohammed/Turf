# Turf backend

The server side of the full CRM (see `TURF_CRM_AND_PERFORMANCE_PLAN.md`). The desktop app's local Skip Tracing service stays in `service/`.

| Folder | Language | What it does |
| --- | --- | --- |
| `rust/` | Rust (Axum, sqlx) | Public API, sign-in and MFA, permissions, CRM transactions, sync, WebSocket events, rule execution, legacy import. Owns the PostgreSQL migrations. `crates/grouping` is the deterministic grouping library shared with offline Skip Tracing. |
| `go/` | Go (standard library) | `turf-worker`: claims outbox events and has the API run their rules (one lead's events in order), ticks the scheduler every minute (overdue tasks and handoffs, scheduled reports), and publishes cache invalidations to Redis. Health on `:8090/healthz`. |

Shared contracts (API, events, jobs, native ABIs) live in `contracts/`.

## Local development

```bash
bash backend/scripts/dev-services.sh
```

This starts PostgreSQL and Redis with their data in `X:\turf-data` (set `TURF_DATA` to change it), creates the roles and prints the connection URLs. Two roles matter:

- `turf_owner` owns the schema and runs migrations.
- `turf_api` is the API's login, a member of `turf_app`. Row security always applies to it, so one organization can never read another's rows.

Run the API:

```bash
cd backend/rust && DATABASE_URL=postgres://turf_api:turf_api@127.0.0.1:55432/turf MIGRATION_DATABASE_URL=postgres://turf_owner:turf_owner@127.0.0.1:55432/turf REDIS_URL=redis://127.0.0.1:56379 TURF_SECURE_COOKIES=false TURF_WORKER_TOKENS=go=change-me-to-a-long-random-token cargo run -p turf-api
```

Tests (unit, contract, and end to end against the real database):

```bash
cd backend/rust && TEST_DATABASE_URL=postgres://turf_api:turf_api@127.0.0.1:55432/turf_test TEST_MIGRATION_DATABASE_URL=postgres://turf_owner:turf_owner@127.0.0.1:55432/turf_test TEST_REDIS_URL=redis://127.0.0.1:56379 cargo test --workspace
```

Without `TEST_DATABASE_URL` the end-to-end tests skip themselves.

### The whole stack, with the CRM interface

```bash
bash backend/scripts/run-api.sh          # API on http://127.0.0.1:8088 (starts PostgreSQL and Redis too)
bash backend/scripts/run-worker.sh       # Go worker
python backend/scripts/dev_seed.py       # once, on a fresh database: an organization, one person per role, sample leads
```

`dev_seed.py` writes the local test accounts to `backend/scripts/.dev-accounts.json` (git-ignored). In the CRM interface (`testing Full CRM mode`, `npm run dev`), open the Turf menu, choose **Connect to a Turf server**, and sign in at `http://localhost:8088`. Owners and administrators need an authenticator code. Records then come from the server. Changes apply on screen at once and queue as operations; offline they wait in an encrypted IndexedDB copy unlocked by a passphrase. On reconnect, a change someone else made meanwhile shows on the Sync page with both values.

## How a change flows

Every CRM write is an operation (`POST /api/v1/ops`, or many at once through `/sync/push`) with a client-chosen id, so a replay gets the first answer back. In one transaction, an operation checks the person's capability and record scope, applies its change, and writes four things: an audit event, a change-log row for `/sync/pull`, an outbox event for workers and rules, and a `NOTIFY` that becomes a WebSocket message.

Workers never touch the database directly. They claim jobs and outbox events through `/internal` with a worker token, and rule actions run back through the same operations path.

## Paid service

Sign-up, the trial, Solo and Business plans, seats, call minutes, checkout and the payment webhook are described in
[docs/saas/README.md](../docs/saas/README.md), with the database diagram. The public website (`website/`) is served by
the API when `TURF_SITE_DIR` is set (`run-api.sh` sets it).
