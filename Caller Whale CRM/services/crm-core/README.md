# crm-core

The CRM's backend: leads, tasks, notes, calls and deals, synced to the web CRM and desktop app. The import worker receives files and stores their rows in PostgreSQL; Core reviews and merges those rows. Plan: [docs/plans/crm-core-and-imports.md](../../docs/plans/crm-core-and-imports.md).

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

## Leads and teams

Each team has settings its team leads, an admin or the owner change (`GET`/`PUT /api/v1/teams/{id}/settings`): whether its agents may claim its unassigned leads (`agents_claim`), the most open leads one agent may hold before claiming more (`open_limit`), and whether its agents see each other's numbers (`leaderboard`). `GET /api/v1/teams/{id}/pool` lists a team's unassigned leads for its leads, deputies and, when claiming is on, its agents; the `lead.claim` operation takes one. A team lead moves leads only between teams they lead; a handoff stays inside the lead's team; only the owner or an admin deletes a lead for good (`lead.delete`), everyone else archives. A team lead gives work and tasks to their teams' people and deputies.

A team can let its agents see all its leads, read-only (`agents_see_team`): those leads come through the snapshot, updates, search and details marked `read_only`, through `cw_seen_lead` and `leadSeen`; every change still checks `cw_visible_lead`, and deals stay with whoever may work the lead. An import into a team starts its new leads unassigned there. A row that matches a lead another team holds waits as `other_team` instead of changing that lead; the importing team sees only how many (`GET /api/v1/imports/{id}/other-team`) and the owner or an admin decides (`POST`, `keep_theirs`, `both` or `move_here`). Within 24 hours of finishing, an import nobody has worked yet is removed with `DELETE /api/v1/imports/{id}/leads` by its importer, a lead of its team, an admin or the owner.

Tags (`/api/v1/tags`): the owner or an admin makes agency tags, a team's leads make tags for their team, and anyone who may edit a lead applies an existing one (`lead.tag`, `lead.untag`); every read of a lead carries its `tag_ids`. A team's lead, an admin or the owner merges a second copy of a person into the first (`lead.merge`): its notes, calls, tasks, deals, handoffs and tags move, its numbers and emails join, and it is put aside with `merged_into`; `lead.unmerge` undoes it for 7 days. Retention (`/api/v1/retention`): the owner or an admin sets how long an unworked lead is kept and sees what is due; leads can be kept with a reason (`/retention/keep`); only the owner removes what is due (`/retention/remove`). Nothing is deleted on its own.

Handing on work (`/api/v1/handon`): someone who left, was removed or is suspended keeps their leads where their team's leads hold and work them; nothing moves on its own, so a suspended person who returns finds what was not handed on. `GET` lists whose work waits and how much (all of it for the owner and admins, a team lead's teams for a team lead); `POST /api/v1/handon/{user}` gives it to one person or back to the team's unassigned leads, optionally one team at a time. Open tasks and callbacks follow their leads with their due times; notes stay on the lead.

## Imports

1. The gateway sends upload start, chunk, resume and complete requests to the import worker. Core receives no uploaded file bytes. The worker authenticates each request with Core's `/api/v1/me`, owns temporary storage, and writes upload metadata to PostgreSQL.
2. The import worker loads it, drops identical rows and columns blank in every row, and proposes what each remaining column is (`status: mapping`). A sparse column with any value stays.
3. `PUT .../mapping` confirms the columns; columns marked unused are left out of the leads (the originals stay in the holding table). The worker cleans the rows and finds repeats (`status: reviewing`, or `ready` when there are none).
4. `GET/POST .../duplicates` lists and settles repeats (merge, import, skip). `POST .../merge` adds the leads in batches of 50,000.

The uploaded CSV exists only in the worker volume during processing and is removed after its rows are loaded. Original cells from completed imports remain as rows in PostgreSQL (`importing.rows`) linked to the resulting lead. Deleting a lead also removes its linked source rows; deleting a source list deletes its leads, related records, import jobs, and source rows. Failed or cancelled holding rows expire after 14 days. Source rows from completed imports before migration `0004` may lack a lead link; deleting their source list still removes them.

## Run and test

```bash
go test ./...
```

One more test checks crm-core's client against a real authz service; set `CRM_TEST_AUTHZ_URL` and `CRM_TEST_AUTHZ_TOKEN` (a `core-api` token of that authz) to run it.

The database tests need a disposable PostgreSQL: `CRM_TEST_ADMIN_URL` (a superuser, to reset the schemas) and `CRM_TEST_DATABASE_URL` (an ordinary login, as production runs, so row security applies). Without them those tests are skipped.

## Coolify

Branch `crm-core-backend-production`, Dockerfile `/Dockerfile`, port 8107, network alias `crm-core`, no domain. Settings: [env/crm-core.production.example](../../env/crm-core.production.example). Core needs no upload volume.

## Clients (build step 23)

`GET /api/v1/clients` (the agency's people: every client with lead counts, members and teams; a client's person: their own), `POST /api/v1/clients {name, approval_required}` and `PATCH /api/v1/clients/{id} {name, approval_required, ended}` (owner, admins), `PUT`/`DELETE /api/v1/clients/{id}/members/{user} {main}` and `/teams/{team}`, and `GET /api/v1/clients/{id}/summary` (figures without names). A list takes `client_id` and `supplied_by` (agency or client); its leads take its client. The `lead.share_client` operation shares a lead with its client's people. A lead or list with no client is the agency's own business.
