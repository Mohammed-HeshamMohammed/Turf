# Notification service

Email, SMS, push and in-app notifications, sent when another service publishes notification.requested. Nothing else.

| | |
| --- | --- |
| Part | Platform service (server) |
| Language | Go 1.23 or newer (not compiled yet: Go was not installed when this was scaffolded) |
| Default port | 8102 |
| Owns data | Yes, its own database schema (`notifications`) |
| Status | Email works: `POST /v1/mail` (templates `mfa_code` and `invitation`). SMS, push and in-app are not built |

## Run and test

```bash
cd services/notifications && go test ./...
cd services/notifications && PORT=8102 go run .
```

## Sending email

`POST /v1/mail` with `Authorization: Bearer <token>` and `{"template": "mfa_code" | "invitation", "to": "...", "data": {...}}`. Tokens are `NOTIFY_TOKENS` (`name=token,...`, 24+ characters each). The mail server login is `NOTIFY_SMTP_HOST/PORT/USER/PASSWORD` and the sender `NOTIFY_MAIL_FROM` (see `env/notifications.production.example`). This is the only service that holds a mail login or writes an email; each caller is limited to 60 requests a minute. 503: no mail server set; 502: the mail server did not take it.

## What it must do

- Answer `GET /healthz` with `{"ok":true,"service":"notifications"}` and `GET /version`.
- Read its port from `PORT` and everything else from environment variables (no files with secrets).
- Keep its API in `openapi.yaml` and change that file in the same pull request as the code.
- Talk to other services only through the gateway or the event bus (`contracts/events.md`), never to their databases.
- Verify the signed-in person from the token's public keys (`/.well-known/jwks.json` of the auth service), never by calling auth on every request.

## Data

This service owns its own PostgreSQL schema and its own database login. Database setup and updates live in `database_setup/` and only this service applies them. No other service may read or write these tables.
