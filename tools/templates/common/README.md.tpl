# __TITLE__

__DESC__

| | |
| --- | --- |
| Part | __PART__ |
| Language | __LANG_NAME__ |
| Default port | __PORT__ |
| Owns data | __OWNS__ |
| Status | Scaffold: it starts, answers `/healthz` and `/version`, and has one test. No business logic yet |

## Run and test

```bash
__RUN__
```

## What it must do

- Answer `GET /healthz` with `{"ok":true,"service":"__NAME__"}` and `GET /version`.
- Read its port from `PORT` and everything else from environment variables (no files with secrets).
- Keep its API in `openapi.yaml` and change that file in the same pull request as the code.
- Talk to other services only through the gateway or the event bus (`contracts/events.md`), never to their databases.
- Verify the signed-in person from the token's public keys (`/.well-known/jwks.json` of the auth service), never by calling auth on every request.

## Data

__DATA__
