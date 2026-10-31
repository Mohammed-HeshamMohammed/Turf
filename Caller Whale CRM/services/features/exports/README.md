# Exports

Feature 7: call lists, mail lists, whole-workspace exports and report files.

| | |
| --- | --- |
| Part | Feature service (server) |
| Language | Python 3.13 or newer (standard library only for now) |
| Default port | 8117 |
| Owns data | Yes, its own database schema (`exports`) |
| Status | Scaffold: it starts, answers `/healthz` and `/version`, and has one test. No business logic yet |

## Run and test

```bash
python -m unittest discover -s services/features/exports/tests
PORT=8117 python services/features/exports/server.py
```

## What it must do

- Answer `GET /healthz` with `{"ok":true,"service":"exports"}` and `GET /version`.
- Read its port from `PORT` and everything else from environment variables (no files with secrets).
- Keep its API in `openapi.yaml` and change that file in the same pull request as the code.
- Talk to other services only through the gateway or the event bus (`contracts/events.md`), never to their databases.
- Verify the signed-in person from the token's public keys (`/.well-known/jwks.json` of the auth service), never by calling auth on every request.

## Data

This service owns its own PostgreSQL schema and its own database login. Database setup and updates live in `database_setup/` and only this service applies them. No other service may read or write these tables.
