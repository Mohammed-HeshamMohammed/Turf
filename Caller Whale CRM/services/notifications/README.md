# Notification service

Email, SMS, push and in-app notifications, sent when another service publishes notification.requested. Nothing else.

| | |
| --- | --- |
| Part | Platform service (server) |
| Language | Go 1.23 or newer (not compiled yet: Go was not installed when this was scaffolded) |
| Default port | 8102 |
| Owns data | Yes, its own database schema (`notifications`) |
| Status | Scaffold: it starts, answers `/healthz` and `/version`, and has one test. No business logic yet |

## Run and test

```bash
cd services/notifications && go test ./...
cd services/notifications && PORT=8102 go run .
```

## What it must do

- Answer `GET /healthz` with `{"ok":true,"service":"notifications"}` and `GET /version`.
- Read its port from `PORT` and everything else from environment variables (no files with secrets).
- Keep its API in `openapi.yaml` and change that file in the same pull request as the code.
- Talk to other services only through the gateway or the event bus (`contracts/events.md`), never to their databases.
- Verify the signed-in person from the token's public keys (`/.well-known/jwks.json` of the auth service), never by calling auth on every request.

## Data

This service owns its own PostgreSQL schema and its own database login. Database setup and updates live in `database_setup/` and only this service applies them. No other service may read or write these tables.
