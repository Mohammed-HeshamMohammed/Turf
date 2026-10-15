# Turf backend

The server side of the full CRM (see `TURF_CRM_AND_PERFORMANCE_PLAN.md`). The desktop app's local Skip Tracing service stays in `service/`.

| Folder | Language | What it does |
| --- | --- | --- |
| `rust/` | Rust (Axum, sqlx) | Public API, sign-in and MFA, permissions, CRM transactions, sync, WebSocket events, rule execution, legacy import. Owns the PostgreSQL migrations. `crates/grouping` is the deterministic grouping library shared with offline Skip Tracing. |

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

## How a change flows

Every CRM write is an operation (`POST /api/v1/ops`, or many at once through `/sync/push`) with a client-chosen id, so a replay gets the first answer back. In one transaction, an operation checks the person's capability and record scope, applies its change, and writes four things: an audit event, a change-log row for `/sync/pull`, an outbox event for workers and rules, and a `NOTIFY` that becomes a WebSocket message.

Workers never touch the database directly. They claim jobs and outbox events through `/internal` with a worker token, and rule actions run back through the same operations path.
