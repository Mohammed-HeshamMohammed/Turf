# Settings and secrets

Every part of Caller Whale reads its settings, secrets included, from one file here. The real files are never committed (git ignores everything in this folder except this README and the `*.example` files), and no script or source file holds a secret of its own.

```bash
node tools/env-init.mjs     # from Full CRM Turf/: creates each missing file from its example, with new random secrets
```

It never overwrites a file. Run it again after an example gains a setting, and it lists what each file is missing.

| File | Read by | Secrets in it |
| --- | --- | --- |
| `core-api.env` | `services/core-api/scripts/run-api.sh` | `CALLERWHALE_WORKER_TOKENS`, `CALLERWHALE_BILLING_WEBHOOK_SECRET` (generated) |
| `worker.env` | `services/core-api/scripts/run-worker.sh` | `CALLERWHALE_WORKER_TOKEN` (the same token as the API's) |
| `auth.env` | `services/auth/scripts/run-auth.sh` | `AUTH_SIGNING_KEY` (generated), `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_APPLE_PRIVATE_KEY` |
| `desktop.env` | the desktop app and the CRM (`vite.config.mjs`), when built or served | None that are server secrets: everything here ships inside the app |
| `compose.env` | `docker compose --env-file env/compose.env -f deploy/compose.yml` | `POSTGRES_PASSWORD`, `AUTH_SIGNING_KEY` (generated) |
| `firebase.env` | `tools/firebase/configure-auth.mjs` | `FIREBASE_SERVICE_ACCOUNT`: the key's JSON itself, not the path of a downloaded key file |

A setting already in the environment wins over the file, so a deploy can set any of them its own way.

Production does not use these files: each server's secrets come from its host's secret store as environment variables with the same names.
