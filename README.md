# crm-core

The CRM's backend: leads, tasks, notes, calls, deals and handoffs, synced to the web CRM and the desktop app, plus uploaded lists. Plan: [docs/plans/crm-core-and-imports.md](../../docs/plans/crm-core-and-imports.md).

| | |
| --- | --- |
| Language | Go |
| Port | 8107 |
| Database | The CRM PostgreSQL: schema `crm` (records) and `importing` (list holding tables). Created at start by numbered, checksummed scripts in `migrations/`; no request can change structure |
| Public address | None of its own. The gateway routes `gate.callerwhale.com` to it |
| Who someone is | The auth service's signed tokens, checked locally with its public keys (`token.go` is copied from `tools/auth-verify`) |
| What they may do | The authorization service (`POST /v1/grant`, `GET /v1/people/{user}`), with crm-core's own `core-api` token; answers are kept for 5 seconds |

## What it answers

`GET /api/v1/me` and `/account`, `/directory`, `/admin/teams`, `/projects`, `PATCH /api/v1/organization`, `POST /api/v1/ops`, `/sync/snapshot`, `/sync/pull`, `/sync/push`, the `/events` WebSocket, the import endpoints under `/api/v1/imports`, and the website's contact form (passed to the notification service).

Every request inside a workspace carries `Authorization: Bearer <token>` and `x-callerwhale-org`. Each runs in a transaction that tells PostgreSQL who is asking; row security then shows only that workspace, and `cw_visible_lead()` only the leads the person's role may see.

## Imports

1. `POST /api/v1/imports` `{filename, size, name?, project_id?}` opens an upload. `PUT /api/v1/imports/{id}/chunks/{n}` sends each 8 MB piece with `x-chunk-sha256` (3 to 4 at a time; a damaged piece is refused with 422 and sent again). `GET /api/v1/imports/{id}` lists the pieces held, so an interrupted upload resumes. `POST .../complete` queues it.
2. The import worker loads it, drops identical rows and proposes what each column is (`status: mapping`).
3. `PUT .../mapping` confirms the columns; columns marked unused are left out of the leads (the originals stay in the holding table). The worker cleans the rows and finds repeats (`status: reviewing`, or `ready` when there are none).
4. `GET/POST .../duplicates` lists and settles repeats (merge, import, skip). `POST .../merge` adds the leads in batches of 50,000.

## Run and test

```bash
go test ./...
```

One more test checks crm-core's client against a real authz service; set `CRM_TEST_AUTHZ_URL` and `CRM_TEST_AUTHZ_TOKEN` (a `core-api` token of that authz) to run it.

The database tests need a disposable PostgreSQL: `CRM_TEST_ADMIN_URL` (a superuser, to reset the schemas) and `CRM_TEST_DATABASE_URL` (an ordinary login, as production runs, so row security applies). Without them those tests are skipped.

## Coolify

Branch `crm-core-backend-production`, Dockerfile `/Dockerfile`, port 8107, network alias `crm-core`, no domain. Settings: [env/crm-core.production.example](../../env/crm-core.production.example). One persistent volume at `/data/imports`, shared with `importing-lists` (user id 65532 must be able to write to it).
