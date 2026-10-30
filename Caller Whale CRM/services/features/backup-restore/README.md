# Backup and restore

Feature 8: the recycle bin, point-in-time restore and workspace downloads.

| | |
| --- | --- |
| Part | Feature service (server) |
| Language | Rust |
| Default port | 8118 |
| Owns data | Yes, its own database schema (`backup_restore`) |
| Status | Scaffold: it starts, answers `/healthz` and `/version`, and has one test. No business logic yet |

## Run and test

```bash
cargo test -p callerwhale-backup-restore
PORT=8118 cargo run -p callerwhale-backup-restore
```

## What it must do

- Answer `GET /healthz` with `{"ok":true,"service":"backup-restore"}` and `GET /version`.
- Read its port from `PORT` and everything else from environment variables (no files with secrets).
- Keep its API in `openapi.yaml` and change that file in the same pull request as the code.
- Talk to other services only through the gateway or the event bus (`contracts/events.md`), never to their databases.
- Verify the signed-in person from the token's public keys (`/.well-known/jwks.json` of the auth service), never by calling auth on every request.

## Data

This service owns its own PostgreSQL schema and its own database login. Migrations live in `migrations/` and only this service applies them. No other service may read or write these tables.
