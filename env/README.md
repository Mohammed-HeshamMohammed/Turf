# Settings and secrets

Every part of Caller Whale reads its settings, secrets included, from one file here. The real files are never committed (git ignores everything in this folder except this README and the `*.example` files), and no script or source file holds a secret of its own.

```bash
node tools/env-init.mjs     # from Caller Whale CRM/: creates each missing file from its example, with new random secrets
```

It never overwrites a file. Run it again after an example gains a setting, and it lists what each file is missing.

| File | Read by | Secrets in it |
| --- | --- | --- |
| `core-api.env` | `services/core-api/scripts/run-api.sh` | `CALLERWHALE_WORKER_TOKENS`, `CALLERWHALE_BILLING_WEBHOOK_SECRET` (generated) |
| `worker.env` | `services/core-api/scripts/run-worker.sh` | `CALLERWHALE_WORKER_TOKEN` (the same token as the API's) |
| `auth.env` | `services/auth/scripts/run-auth.sh` | `AUTH_SIGNING_KEY` (generated), `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_APPLE_PRIVATE_KEY` |
| `desktop.env` | the desktop app and the CRM (`vite.config.mjs`), when built or served | None that are server secrets: everything here ships inside the app |
| `compose.env` | `docker compose --env-file env/compose.env -f deploy/compose.yml` | `POSTGRES_PASSWORD`, `AUTH_SIGNING_KEY` (generated) |
| `gateway.env` | the gateway (`services/gateway`), when run locally | None |
| `*.production.example` | Coolify: the values to paste into each application's Environment Variables, Developer View (`auth`, `core-api`, `worker`, `gateway`, `landing-web`, `landing-api`, `grafana`). Fill every `<...>`; keep secrets in Coolify, never in the repository | Marked `<...>` |
| `firebase.env` | `tools/firebase/configure-auth.mjs` (one-time Firebase project setup for the auth service) | `FIREBASE_SERVICE_ACCOUNT`: the key's JSON itself, not the path of a downloaded key file |

A setting already in the environment wins over the file, so a deploy can set any of them its own way.

Production does not use these files: each server's secrets come from its host's secret store as environment variables with the same names.


## Database setup and updates

- `DATABASE_URL`: the application's restricted connection for ordinary reads and writes.
- `DATABASE_SETUP_URL`: the schema owner's connection, used only to create or update database structure.
- `CORE_API_DATABASE_SETUP_URL`: the same owner connection in local `database.env`, read by the configuration generator.
- `TEST_DATABASE_SETUP_URL`: the owner connection to a dedicated test database.
- `database_setup/`: the ordered SQL scripts shipped with a service or the desktop project store.
- `database_setup_history`: records completed scripts so restarting does not run them again.
- `callerwhale-api setup-database`: explicitly apply setup without starting the API server.

Update the stored core-api variable in Coolify to `DATABASE_SETUP_URL` before deploying
this version. Its value stays the same owner connection string. Existing databases
keep their completed-script history: startup adopts the old history table automatically.
Do not edit previously applied SQL files: their original checksums protect against drift.
SQLx dependency API names retain upstream spelling; they are not operator settings.


## Container health reporting in Coolify

For `core-api`, use **Container command** `/usr/local/bin/callerwhale-api health`,
with a 40-second startup grace period. The slim image has no curl or wget; a Coolify
HTTP probe would override the image's working health check and mark it unhealthy.
Auth and the worker also ship their own Dockerfile health commands.
