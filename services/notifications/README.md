# Notification service

Email, SMS, push and in-app notifications, sent when another service publishes notification.requested. Nothing else.

| | |
| --- | --- |
| Part | Platform service (server) |
| Language | Go 1.23 or newer (not compiled yet: Go was not installed when this was scaffolded) |
| Default port | 8102 |
| Owns data | Yes, its own database (`DATABASE_URL`, schema `notifications`): the mail queue only |
| Status | Email works: `POST /v1/mail` (templates `mfa_code`, `invitation` and `confirm_email`). SMS, push and in-app are not built |

## Run and test

```bash
cd services/notifications && go test ./...
cd services/notifications && PORT=8102 go run .
```

## Sending email

`POST /v1/mail` with `Authorization: Bearer <token>` and `{"template": "mfa_code" | "invitation" | "confirm_email", "to": "...", "data": {...}}`. Tokens are `NOTIFY_TOKENS` (`name=token,...`, 24+ characters each). The mail server login is `NOTIFY_SMTP_HOST/PORT/USER/PASSWORD` and the sender `NOTIFY_MAIL_FROM` (see `env/notifications.production.example`). This is the only service that holds a mail login or writes an email; each caller is limited to 60 requests a minute. 503: no mail server set; 502: the mail server did not take it.

## The mail queue

With `DATABASE_URL` set, `POST /v1/mail` and the contact form save the finished email and answer `202 {"ok": true, "queued": true}`
at once; a sender in this same container delivers it (`queue.go`). Without it, every email is sent during its request
(`queued: false`) and one the mail server does not take is lost, as before.

- **Retries.** A mail server that is down, slow or answers "try later" (4xx) is tried again after 10 s, 20 s, 40 s ... up to 10
  minutes between tries. A 5xx answer about the message itself (no such recipient, content refused) is final: the email is dropped
  and logged.
- **Too old to matter.** A sign-in code (`mfa_code`) is dropped after 10 minutes unsent, every other email after 24 hours, each
  with a log line. So the table holds only what is still on its way; an email is deleted the moment the mail server takes it.
  Sign-in codes are in the database only for that short time.
- **Two copies.** Each takes different rows (`FOR UPDATE SKIP LOCKED`) and leases them for 2 minutes, so a copy that stops
  mid-send only delays those emails. Order does not matter for email, so nothing waits on anything else. Up to 4 go out at once.
- **Woken at once.** A new email wakes the sender in the copy that took the request; retries are checked every 5 seconds.
- **The database down never stops mail.** An email that cannot be queued is sent during its request instead, and a database that
  cannot be reached at start means direct sending until the next start.
- **The database.** A database named `notifications` on any PostgreSQL the platform already runs (no container of its own); the
  service makes its schema and table (`database_setup/`). Tests: `NOTIFY_TEST_DATABASE_URL` (a login that may drop and make the
  `notifications` schema).

## What it must do

- Answer `GET /healthz` with `{"ok":true,"service":"notifications"}` and `GET /version`.
- Read its port from `PORT` and everything else from environment variables (no files with secrets).
- Keep its API in `openapi.yaml` and change that file in the same pull request as the code.
- Talk to other services only through the gateway or the event bus (`contracts/events.md`), never to their databases.
- Verify the signed-in person from the token's public keys (`/.well-known/jwks.json` of the auth service), never by calling auth on every request.

## Data

This service owns its own PostgreSQL schema and its own database login. Database setup and updates live in `database_setup/` and only this service applies them. No other service may read or write these tables.
