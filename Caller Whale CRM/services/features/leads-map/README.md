# Leads map

Feature 4: exact locations, reverse lookups and nearby search for leads.

| | |
| --- | --- |
| Part | Feature service (server) |
| Language | Rust |
| Default port | 8114 |
| Owns data | Yes, its own database schema (`leads_map`) |
| Status | Scaffold: it starts, answers `/healthz` and `/version`, and has one test. No business logic yet |

## Run and test

```bash
cargo test -p callerwhale-leads-map
PORT=8114 cargo run -p callerwhale-leads-map
```

## What it must do

- Answer `GET /healthz` with `{"ok":true,"service":"leads-map"}` and `GET /version`.
- Read its port from `PORT` and everything else from environment variables (no files with secrets).
- Keep its API in `openapi.yaml` and change that file in the same pull request as the code.
- Talk to other services only through the gateway or the event bus (`contracts/events.md`), never to their databases.
- Verify the signed-in person from the token's public keys (`/.well-known/jwks.json` of the auth service), never by calling auth on every request.

## Data

This service owns its own PostgreSQL schema and its own database login. Database setup and updates live in `database_setup/` and only this service applies them. No other service may read or write these tables.
