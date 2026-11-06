# CRM core and list imports (web CRM first)

**Status:** agreed with the owner on 2026-11-06, nothing built yet. Scope: the web CRM at `app.callerwhale.com` only; the desktop app keeps its local import.

## Why

The web CRM shows "Caller Whale's server cannot be reached". It asks `gate.callerwhale.com` for `/api/v1/account`, `/api/v1/me` and `/sync/*`, but no core API runs: the Rust one was removed (`75bbee5`) and the Go rebuild was only planned. In production `gate` points at the notification service, which answers those paths with 404, and the browser reports that as a blocked preflight.

## What gets built

| Piece | Kind | Language | Job |
| --- | --- | --- | --- |
| **CRM PostgreSQL** | Database (new, Coolify) | - | Leads, tasks, notes, calls, deals, handoffs, workspaces, the change feed, the import holding tables and the job queue. One database, separate schemas and logins |
| **crm-core** | App, always on | Go | The CRM's backend. `gate.callerwhale.com` points here. It is the `core-api` caller authz already knows |
| **importing-lists** | App, always on but idle until a job is queued | Python with polars | Turns an uploaded file into rows in SQL, removes duplicates, matches columns, cleans data (fills in the existing scaffold in `services/features/importing-lists`) |

Not needed: a storage bucket (files come through our server), a second Redis (the existing one can serve live progress later), separate databases per service.

## Language decisions

- **Go** for request handling (gateway, auth, authz, crm-core, MCP): many small fast requests, quick rebuilds.
- **Python** for data work (imports, skip tracing, exports, analysis, machine learning). Heavy steps run inside polars (Rust underneath) or Postgres, never in per-row Python loops.
- **C++ was considered and not chosen:** the slow part of an import is Postgres, not parsing; C++ would not remove the Excel or deploy issues; memory bugs on untrusted files would be a security risk; it takes longer to build and change.
- **No new Rust services:** hard to connect with the other languages and slow to rebuild. `services/README.md` still lists `crm`, `leads-map` and `backup-restore` as Rust; `crm` becomes Go (crm-core), the other two are decided when they are built.

## crm-core, first version

Answers what the web CRM calls today (`desktop/frontend/react/src/remote/api.ts`, `RemoteGate.jsx`, `remote/engine.ts`, `remote/translate.ts`):

- `GET /api/v1/account`, `GET /api/v1/me` (person, workspaces, roles, capabilities, second-step state, plan state, access revision).
- `GET /sync/snapshot`, `GET /sync/pull`, `POST /sync/push` with the operation kinds in `translate.ts` (`lead.*`, `note.*`, `task.*`, `call.record`, `deal.*`, `handoff.*`; `message.draft` refused until messaging exists).
- `GET /events` (WebSocket) so the CRM syncs as soon as something changes.
- `GET /api/v1/directory`, `GET /api/v1/admin/teams`, `GET /api/v1/projects`.
- The import endpoints below.
- Forwards `POST/OPTIONS /api/v1/public/contact` to the notification service, so the website's contact form keeps working when `gate` moves.

Where facts come from:
- **Who:** the auth token, checked locally with auth's public keys (`tools/auth-verify`, copied into crm-core).
- **Workspaces, roles, capabilities, record scope, suspended or unpaid:** authz (`GET /v1/people/{user}`, `POST /v1/grant`) with crm-core's own `core-api` token, cached for a few seconds.
- **Workspace names and people's display names:** crm-core keeps them (authz holds only ids and roles).

Dialer, texting and campaigns come later.

## Imports

Agreed requirements: files up to 1 GB and more (CSV, TXT, XLSX, XLS), for example 500,000 rows by 20 columns in one go; saved through our server, not a bucket; stored as rows in Postgres, not as files.

| Step | What happens | Where |
| --- | --- | --- |
| 1. Upload | The browser cuts the file into many pieces of about 8 MB, sends 3 to 4 at a time, each checked by its fingerprint; a broken piece is sent again and a dropped connection resumes. Each request stays far under Cloudflare's 100 MB limit | Browser to crm-core, into a folder both apps share |
| 2. Into SQL | The worker reads the pieces in order as one stream and loads rows into a holding table in bulk; each piece is deleted once used | Import worker |
| 3. Exact duplicates | Identical rows are dropped as they load (one fingerprint per row) and reported with examples. No consent needed: nothing is lost | Import worker |
| 4. Simple processing | Columns are matched to CRM fields (`field-vocabulary.ts`, `skiptrace-fields.ts`); columns the CRM does not use (for example "Bathroom style", "Relative 6") are marked "not used" and dropped only after the person confirms; phones and addresses are cleaned | Import worker |
| 5. Near duplicates | Rows that match after cleaning, or match existing leads, are shown; the person merges, keeps or skips them | Import worker, the person decides |
| 6. Into leads | Merged in batches of about 50,000 so the CRM stays usable | crm-core |
| 7. Skip tracing | Later, in the skip-tracing area, on the leads the person picks | Skip-tracing service |

What happens to marked rows or columns the person never answers about: decided later.

The import worker's database login writes only to the holding tables and reads only the matching fields of leads; it can never change or delete a lead.

## Living with an 8 GB, 2-core server

| What | Memory |
| --- | --- |
| Everything running today | about 2 GB |
| CRM PostgreSQL | up to 1 to 1.5 GB |
| crm-core | about 100 MB |
| Import worker | capped at 768 MB to 1 GB, at most 1 core, lower CPU priority |
| Coolify builds | 1 to 2 GB for a few minutes (until images are built on GitHub) |
| Spare | about 2 GB |

- **Excel has no size limit:** sheets are read row by row, so memory stays small; big Excel files are slower than CSV, not refused.
- **Deploys are allowed during imports:** images will be built on GitHub instead of the server, and an import saves its progress after every batch and continues after a restart.
- **One big import at a time** across the server; others wait in the queue (agreed).
- **Growth:** upgrade the VPS or move the import worker to its own small server, with no code change (agreed).
- A 1 GB CSV is expected to take about 5 to 15 minutes on this server, with progress and Cancel.

## Known limit to solve next

The web CRM keeps every visible lead in the browser (snapshot plus sync). That suits thousands of leads, not millions. For large workspaces the lead lists must page from the server; this is a CRM screen change that follows the first version.

## Build order

1. crm-core: identity, sync and the operation kinds, with tests. Gateway route and env examples. Production branch.
2. importing-lists: queue, upload assembly, load and exact duplicates, column matching, cleaning, near duplicates, resume after restart, with tests.
3. crm-core import endpoints and the merge into leads.
4. Coolify: CRM PostgreSQL, the two apps, the shared folder, resource caps, then point `gate` at crm-core and check the CRM opens.
5. The CRM's import screen for the web (pieces, progress, review).
6. Images built on GitHub.

Secrets (database passwords, the `core-api` token for authz) are set by the owner in Coolify; they are never typed by an assistant.
