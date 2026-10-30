# Dialer, auto dialing and SMS

Feature 3: calling, auto dialing, texting, number health, call logs and the carrier webhooks.

| | |
| --- | --- |
| Part | Feature service (server) |
| Language | TypeScript (Node 24 or newer, no build step) |
| Default port | 8113 |
| Owns data | Yes, its own database schema (`dialer_sms`) |
| Status | Scaffold: it starts, answers `/healthz` and `/version`, and has one test. No business logic yet |

## Run and test

```bash
npm --prefix services/features/dialer-sms test
PORT=8113 npm --prefix services/features/dialer-sms start
```

## What it must do

- Answer `GET /healthz` with `{"ok":true,"service":"dialer-sms"}` and `GET /version`.
- Read its port from `PORT` and everything else from environment variables (no files with secrets).
- Keep its API in `openapi.yaml` and change that file in the same pull request as the code.
- Talk to other services only through the gateway or the event bus (`contracts/events.md`), never to their databases.
- Verify the signed-in person from the token's public keys (`/.well-known/jwks.json` of the auth service), never by calling auth on every request.

## Data

This service owns its own PostgreSQL schema and its own database login. Migrations live in `migrations/` and only this service applies them. No other service may read or write these tables.
