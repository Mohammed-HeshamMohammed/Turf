# CRM core and list imports (web CRM first)

**Status:** agreed with the owner on 2026-11-06; steps 1 to 3 of the build order are built and tested (see "Built so far" at the end); steps 4 to 6 are the owner's Coolify work and the CRM's import screen. Scope: the web CRM at `app.callerwhale.com` only; the desktop app keeps its local import.

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

Answers what the web CRM calls today (`apps/crm/src/remote/api.ts`, `RemoteGate.jsx`, `remote/engine.ts`, `remote/translate.ts`):

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
| 1. Upload | The browser cuts the file into many pieces of about 8 MB, sends 3 to 4 at a time, each checked by its fingerprint; a broken piece is sent again and a dropped connection resumes. Each request stays far under Cloudflare's 100 MB limit | Browser through gateway to the import worker, into its own persistent volume |
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
| Import worker | **no cap** (owner's decision, 2026-11-06): it uses what a list needs. Measured: a 500,000-row, 20-column file peaked at about 600 MB |
| Coolify builds | 1 to 2 GB for a few minutes (until images are built on GitHub) |
| Spare | about 1 to 2 GB, less while a very large list is being cleaned |

- **Excel has no size limit:** sheets are read row by row, so memory stays small; big Excel files are slower than CSV, not refused.
- **Deploys are allowed during imports:** images will be built on GitHub instead of the server, and an import saves its progress after every batch and continues after a restart.
- **One big import at a time** across the server; others wait in the queue (agreed). With no cap on the worker, this is also what keeps it from taking the whole machine twice over.
- **Growth:** upgrade the VPS or move the import worker to its own small server, with no code change (agreed).
- A 1 GB CSV is expected to take about 5 to 15 minutes on this server, with progress and Cancel.

## Known limit to solve next

The web CRM keeps every visible lead in the browser (snapshot plus sync). That suits thousands of leads, not millions. For large workspaces the lead lists must page from the server; this is a CRM screen change that follows the first version.

## Build order

1. crm-core: identity, sync and the operation kinds, with tests. Gateway route and env examples. Production branch.
2. importing-lists: queue, upload assembly, load and exact duplicates, column matching, cleaning, near duplicates, resume after restart, with tests.
3. crm-core import endpoints and the merge into leads.
4. Coolify: CRM PostgreSQL, the two apps, the worker's persistent upload volume, resource caps, then point `gate` at crm-core and check the CRM opens.
5. The CRM's import screen for the web (pieces, progress, review).
6. Images built on GitHub.

Secrets (database passwords, the `core-api` token for authz) are set by the owner in Coolify; they are never typed by an assistant.

## Built so far (2026-11-06)

- **crm-core** (`services/crm-core`, Go, port 8107): `/api/v1/me`, `/account`, `/directory`, `/admin/teams`, `/projects`, `/ops`, `/credits/use`; `/sync/snapshot`, `/pull`, `/push` with every operation kind the web CRM sends except `message.draft` (refused until messaging exists); the `/events` WebSocket over PostgreSQL `LISTEN/NOTIFY`; the contact-form pass-through; CORS for the listed pages. Database tables and row security are created at start by numbered, checksummed scripts. Tested against a real PostgreSQL, including that a workspace never sees another's records.
- **Imports, crm-core side:** mapping confirmation, repeat decisions, and the merge into leads in batches of 50,000 (resumes after a restart; cancel stops between batches).
- **importing-lists** (`services/features/importing-lists`, Python and polars): assembly, load, exact duplicates, column suggestions, cleaning, repeats inside the file and against existing leads, resume after a restart, one import at a time. 500,000 rows by 20 columns: about 18 s to load, about 70 s to clean and find repeats, peak memory about 600 MB.
- **Decided while building:** a workspace the CRM has never seen is named after the person who opened it until an administrator renames it (`PATCH /api/v1/organization`); a person's access revision is derived from what authz grants them, so a change in roles resets their devices without a counter to keep; pieces are joined into one file as they are used and the file is kept until the load finishes (a restart needs it), then deleted.
- **Also built since:** the CRM's import screen (`ServerImport.jsx`), a limit of 3 imports in progress per workspace, a guard against spreadsheets that unpack absurdly, refusal of XML entity tricks (`defusedxml`), and a clean-up that deletes the holding rows of finished, failed or cancelled imports after 14 days (the import's own record stays).
- **Checked against the real thing:** the worker's database login can do its job and nothing else (it cannot read or change leads, or change structure); crm-core's client reads the real authz service's answers correctly (`CRM_TEST_AUTHZ_URL`, `CRM_TEST_AUTHZ_TOKEN`).

### Left for later (none of it blocks deploying)

- **Lead paging for very large workspaces.** The web CRM keeps every visible lead in the browser; that suits thousands of leads, not millions. Lead lists must page from the server (a CRM screen change).
- **Messaging, notifications and followers.** `message.draft` is refused until messaging exists; their tables are not created yet.
- **Rules and reports** (the old core API had them).
- **Per-group decisions on repeats.** The screen settles all repeats at once (merge, keep all, leave out); the endpoint already takes a decision per group.
- **Images built on GitHub** instead of on the server (step 6 of the build order).
- **Formula safety in exports.** When exports of imported data exist, cells starting with `=`, `+`, `-` or `@` must be written with a leading quote.
- **Server disk alert.** An alert in Coolify, or a separate disk for the imports volume, covers many large uploads filling the disk.

## Reorganising imports and lists (decided 2026-11-10)

Problem: the import itself runs on the server, but `/sync/snapshot` sends every visible lead in one response, and the browser then holds them all in memory and in the encrypted offline copy. Big lists and weak PCs crash. (Sources: `services/crm-core/sync.go` snapshot, `apps/crm/src/remote/engine.ts`.)

Decisions:

- **Leads stay on the server.** Lists, search, filters and sort are server queries that return one page (about 50 rows) and a total count. The browser holds only the page in view.
- **The snapshot no longer carries leads.** It keeps the small collections (tasks, notes, deals, team) and the leads come in pages.
- **The web CRM has no offline mode** (decided 2026-11-10): no device password, nothing kept on the computer; the screen is skipped (`RemoteGate.jsx`). Offline stays in the desktop app only.
- **In the desktop app, offline is small and optional.** The offline copy covers only the person's own work (their assigned leads, notes and tasks), with a size cap, never the whole workspace. Skipping the offline copy costs nothing.
- **No calls can be made offline.** Starting a call needs the connection: the call buttons are off while the CRM is offline, and the offline copy needs no call queue. Notes, tasks and outcomes of earlier calls can still be written offline and sync later.
- **A finished import does not touch devices.** Devices show a "new list ready" notice and pull leads only when the list is opened.
- **Import dialog:** pick the file, check the column suggestions, one "Add to workspace" button; progress survives closing the tab. Repeat handling and cleaning stay on the server.

Built 2026-11-10: the snapshot sends a window of 3,000 leads (the person's own first, then the most recently changed) with the real totals and per-list counts; `GET /api/v1/leads/search` (name, phone, email, address; 100 a page) reaches the rest and the Leads page searches it as you type; a device more than 5,000 changes behind is told to take a fresh snapshot instead of paging; a device holds at most 5,000 leads and ignores notes, calls and the like for leads it does not hold. Still to do: the lead list paging itself (a real page of 50 with sorting by the server), the offline copy of the desktop app, and switching call buttons off offline.

Built 2026-11-13: `GET /api/v1/leads/{id}/details` answers one lead's tasks, notes, calls, handoffs and deals (deals only with the finance capability; a lead the person cannot see is a 404), so a lead outside the device's window shows its details when opened. On the device `lead-source.ts` is the one place that asks for pages of leads and lead details: an answer is kept, shown at once, and refreshed quietly when a sync changes leads. Not yet run against a live server: the Go handler and its test were written without a Go toolchain.

### What the owner does in Coolify (step 4)

1. Create the CRM PostgreSQL resource, a login `crm_core` for crm-core, and (after crm-core has started once) `CREATE ROLE importer LOGIN PASSWORD '...'`.
2. Add `core-api=<token>` to authz's `AUTHZ_TOKENS`; redeploy authz.
3. Create `crm-core` and `importing-lists` from their production branches, one persistent volume at `/data/imports` in both, using `env/crm-core.production.example` and `env/importing-lists.production.example`. Leave the worker uncapped.
4. In the gateway's `ROUTES` change `gate.callerwhale.com=http://notifications:8102` to `gate.callerwhale.com=http://crm-core:8107`, and redeploy it.
