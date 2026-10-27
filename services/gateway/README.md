# Gateway

The one public entry point: HTTPS, token check, rate limits, and routing of /api/v1/<service>/* to the service behind it.

| | |
| --- | --- |
| Part | Platform service (server) |
| Language | Go 1.23 or newer (not compiled yet: Go was not installed when this was scaffolded) |
| Default port | 8100 |
| Owns data | No |
| Status | Scaffold: it starts, answers `/healthz` and `/version`, and has one test. No business logic yet |

## Run and test

```bash
cd services/gateway && go test ./...
cd services/gateway && PORT=8100 go run .
```

## What it must do

- Answer `GET /healthz` with `{"ok":true,"service":"gateway"}` and `GET /version`.
- Read its port from `PORT` and everything else from environment variables (no files with secrets).
- Keep its API in `openapi.yaml` and change that file in the same pull request as the code.
- Talk to other services only through the gateway or the event bus (`contracts/events.md`), never to their databases.
- Verify the signed-in person from the token's public keys (`/.well-known/jwks.json` of the auth service), never by calling auth on every request.

## Data

This service keeps no data of its own.
