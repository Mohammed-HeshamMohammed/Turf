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

Part B: the `call.share_client` and `deal.share_client` operations share one call or deal with the lead's client; `POST /api/v1/projects/{id}/approval/send` sends a list to its client, `POST /api/v1/projects/{id}/approval {approved, note}` is the client's answer, `GET /api/v1/clients/{id}/approvals` lists them, and a list waiting for a client that requires approval is not called or texted (the dialer is told `waiting_approval`). `GET /api/v1/leads/{id}/twins` (owner, admins) says whether the number is also a lead under another client.

## Do not call (build step 25)

Blocks belong to a number (its last ten digits), never to a lead's other numbers. A number blocked for calls makes every lead of the agency with it do-not-call, and a trigger keeps imports and new leads in line.

- **The agency's block list** (asked this agency to stop): marking a lead do-not-call, a "Do not call" call (also from an import), or `POST /api/v1/blocks {phone, calls, texts, note, lead_id}` (anyone who calls or texts) blocks the number for every client and team. `GET /api/v1/blocks` (owner, admins) is the list with who marked and lifted each; `POST /api/v1/blocks/lift {phone, reason}` (owner, admins, reason required) lifts it. A lead's own flag cannot be cleared while its number is blocked. `GET /api/v1/blocks/check?phone=` says what is blocked and why.
- **Caller Whale's database**, read by every agency: a "Do not call" call with `dnc_kind: "anyone"` (the agent confirms the person wants no calls from anyone) blocks every agency at once; `kind: "complainer"` on `POST /api/v1/blocks` waits until a second agency reports the number or staff confirm it. Registry numbers are never copied here. `POST /api/v1/blocks/review {phone, reason}` (owner, admins) asks staff to look again. Staff: `GET /api/v1/platform/do-not-call` (complainers waiting, open reviews with every mark, anyone who marked more than 20 numbers in a day), `POST /api/v1/platform/do-not-call/{id}/confirm`, `/remove {reason}` (kept with the row), `POST /api/v1/platform/do-not-call/reviews/{id}/keep {note}`.
- **Consent for a list**: `POST /api/v1/projects/{id}/text-consent {confirm}` (whoever imports) records that the agency holds consent to text the list, for its client only.
- The dialer's `/internal/v1/dialer/lead` answer carries `blocked_calls`, `blocked_texts`, `block_reason` and `list_consent`; `/internal/v1/dialer/block` takes a lead's opt-out reply (`{calls, texts, note}`) or START (`{lift: true}`, which lifts only a block a reply made).

## Scripts, call review and the AI's switches (build step 26, part A)

- **Scripts** belong to a client (none: the agency's own business). `POST /api/v1/scripts {client_id, team_id, name, body}`, `PATCH /api/v1/scripts/{id} {name, body}`, `DELETE /api/v1/scripts/{id}`. A client's script is written by the owner, admins or the leads of a team working for that client; a team's own version (`team_id`) by that team's leads. One active script per client and per team version. `GET /api/v1/scripts` lists what the person may read; `GET /api/v1/leads/{id}/script` is the lead's script: its team's version, else its client's. Agents never change scripts.
- **Call review**: `POST /api/v1/calls/{id}/review {scores: {item: 1-5}, comment}` by a lead or deputy of the lead's team, an admin or the owner, never on their own call, against the agency's checklist (`review_checklist` in the AI settings). `GET /api/v1/calls/{id}/reviews` (the call's agent and reviewers), `GET /api/v1/reviews/mine` (own scores and average), `GET /api/v1/teams/{id}/reviews?days=` (the team's and each agent's average, for its leads and deputies, admins and the owner).
- **The AI's switches**: `GET /api/v1/ai-settings`; `PUT /api/v1/ai-settings {ai_suggestions, captions_required}` (the owner) and `{review_checklist}` (owner, admins); `PUT /api/v1/teams/{id}/ai {ai_suggestions: false|null}` (a team's leads switch them off for the team); `PUT /api/v1/me/suggestions {hidden}` (a person hides them; required captions keep running). The dialer's lead answer carries `ai_suggestions` and `captions_required`.

## The in-app assistant (build step 26, part C)

With `ASSISTANT_URL` and `ASSISTANT_TOKEN`: `POST /api/v1/assistant/leads/{id}/summary`, `POST /api/v1/assistant/leads/{id}/draft {kind: text|email, request}` (never a text to a blocked number), `POST /api/v1/assistant/ask {question}` ("how do I", private, not kept) and `POST /api/v1/assistant/leads/{id}/save {kind: summary|text|email, text}` (the person's text as a note on the lead). Only what the person may see is sent, without the lead's phone, email or address. With `BILLING_URL` and `BILLING_TOKEN` each use is charged as kind `ai`: about a lead to its team and client, otherwise to the person; billing refuses past a budget (402) or the person's daily cap (429).

## Commissions (build step 27)

Optional per agency, off until the owner switches it on. `GET /api/v1/commissions/settings` (anyone in the agency) and `PUT {on, split}` (the owner; `split` is the caller's percent of a deal's commission when a caller set it up). `PUT /api/v1/commissions/rules {role | user_id, per_appointment, deal_percent}` and `DELETE /api/v1/commissions/rules/{id}` (the owner): a person's rule comes before their role's. An appointment is a call logged "Transfer"; a deal earns when it is "Closed won" (who moved it there and when are kept on the deal), its fee or else its amount times the closer's percent. `PUT /api/v1/commissions/overrides {source: appointment|deal, source_id, user_id, amount, reason}` (the owner; amount null removes it). `GET /api/v1/commissions?from=&to=` lists each item and the totals per person and currency: the owner and admins see everyone, anyone else their own. No payment is made.

## Pipeline, booking and deal credit (build step 28, part A)

- **Stages**: `GET /api/v1/pipeline?client_id=`; `PUT /api/v1/pipeline {client_id, stages}` (owner, admins): the agency's open stages, or a client's own (`stages: null` goes back to the agency's). "Closed won" and "Closed lost" always end a deal. A new deal starts in the first stage.
- **Closers' hours**: `GET`/`PUT /api/v1/closers/{user}/hours {days: [{weekday, from, until}]}` (the closer, their team's leads, admins, the owner), inside `PUT /api/v1/closers/{user}/limit {from, until}` (the leads, admins, the owner; hours outside are cut). Times are in the agency's time zone; slots are the agency's `slot_minutes` (30 by default).
- **Booking**: `GET /api/v1/teams/{id}/slots?days=` (anyone in the team): each closer's free slots. `POST /api/v1/appointments {lead_id, closer_id, starts_at}` (a caller who works the lead, a closer of the lead's team, a free slot): it becomes an appointment task on the closer's list. `POST /api/v1/appointments/{id}/cancel`, `GET /api/v1/appointments?lead_id=`.
- **Credit**: a deal moved to "Closed won" is credited to its closer (who moved it) and its caller (who booked its latest appointment, else who logged its latest "Transfer"), with team and client (`deal_credits`); its lead becomes Closed / Won and leaves the queues. Commissions read the credits and count booked appointments.

## Google Calendar (build step 28, part B)

With `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URL`, `GOOGLE_TOKEN_KEY` and `APP_URL`: `POST /api/v1/me/google/connect` answers Google's consent page for the person; Google returns them to `GET /api/v1/google/callback` (open at the gateway: a one-use state made for them in the last 10 minutes says who they are), then to `APP_URL/?google=connected`. Only two permissions are asked for: when the person is busy (`calendar.freebusy`), and a calendar of Caller Whale's own in their account (`calendar.app.created`); their other events are never read or changed. The token is stored encrypted. Busy times are left out of the team's slots; a booking becomes an event on the closer's "Caller Whale" calendar with the time and a link to the lead in its agency, never the lead's name or number; cancelling removes it; handing a person's work on moves their coming appointments and events to whoever takes it. `GET /api/v1/me/google`; `DELETE /api/v1/me/google` removes the events and revokes access.

## Email to leads (build step 29)

With `EMAIL_SES_REGION` (and the SES login), `EMAIL_PUBLIC_URL`, `EMAIL_REPLY_DOMAIN` and `EMAIL_SNS_TOPIC_ARN`:
- `GET`/`PUT /api/v1/email/settings {postal_address}` (owner, admins): the address every email carries.
- `POST /api/v1/email/domains {domain, client_id, from_local}` (owner, admins) answers the DNS records to add (DKIM, SPF, DMARC); `POST /api/v1/email/domains/{id}/check` marks it verified; `GET /api/v1/email/domains`. One agency per domain.
- `POST /api/v1/leads/{id}/emails {subject, body}` (whoever works the lead and may message): plain text from the lead's client's verified domain, else the agency's, signed "name | agency", ending with the agency's address and an unsubscribe link (also the one-click `List-Unsubscribe` header); links become tracked links; replies go to `reply+<token>@EMAIL_REPLY_DOMAIN`. `GET /api/v1/leads/{id}/emails` is the thread with each link's clicks. Opens are never tracked.
- Open routes: `GET /api/v1/public/email/l/{token}` (a click), `GET`/`POST /api/v1/public/email/u/{token}` (the unsubscribe page and its button, or the mail app's one-click POST: blocks the address for the agency), `POST /api/v1/public/email/inbound` (SNS; the topic must match and the signature must verify against Amazon's certificate). A reply lands on the lead without the quoted email; left unanswered for 15 minutes, the team's leads and deputies (the owner when the team has none) get a task. Writing to the lead answers it.

## Protecting leads (build step 30)

- **Masked numbers**: anyone who is not a team lead, deputy, admin or the owner sees a lead's number as "••• 1234" everywhere the CRM sends it (leads, calls, snapshots, searches, other contacts); the dialer still dials the real number, which only the CRM gives it. `PUT /api/v1/teams/{id}/full-numbers {on}` (the owner) shows a team's agents full numbers. Someone who sees a number masked cannot change it; a call their device logs with the masked number keeps the real one.
- **Exports**: `GET /api/v1/leads/export?team_id=` is a CSV (formula-like cells kept as text): the owner and admins any leads; a team lead only a team they lead, and only when the owner set `managers_export` (`PUT /api/v1/protection {managers_export, view_keep_days}`); agents never. Each export is kept: `GET /api/v1/exports?user_id=`.
- **Who opened what**: opening a lead's details is recorded; `GET /api/v1/leads/{id}/views` and `GET /api/v1/people/{user}/views?days=` (opened leads and exports, for a removed person too) for the owner and admins, within the agency's keeping time (90 days by default).
- **Unusual access**: opening leads and paging through searches are counted per 10 minutes; more than 5 times the person's usual (and at least 60) records an alert (`GET /api/v1/protection/alerts`, owner and admins) and slows each lead they open by 2 seconds for 30 minutes. Nothing is blocked.

## Setup, walk-throughs and material (build step 31)

- `GET /api/v1/setup` (owner, admins): name, hours, first team, first client, invite, authenticator, data processing agreement; each `done`, `skipped` or `todo`. What the CRM sees counts by itself (a renamed agency, a team, a client, someone besides the owner, an authenticator used in this sign-in, the accepted agreement). `POST /api/v1/setup/{step} {status: done|skipped|todo}`.
- `GET`/`POST /api/v1/agreements/dpa {version}`: the owner accepts the current version (`dpaVersion`, a draft until the lawyer writes it); who accepted which version and when is kept.
- `GET /api/v1/me/walkthroughs` (the person's roles still to see here), `POST {role}` (seen).
- `POST /api/v1/material {title, url | body, team_id}` (owner, admins; a team lead for their team), `DELETE /api/v1/material/{id}`, `POST /api/v1/material/{id}/assign {user_ids, due_at}` (to people the asker manages), `POST /api/v1/material/{id}/finish`, `GET /api/v1/material` (mine, and for managers all with counts), `GET /api/v1/material/{id}/progress`.

## Overviews and reports (build step 32)

- `GET /api/v1/overview` (owner, admins): what needs them today (work to hand on, people held, overdue callbacks by team, emails waiting, access alerts today, lists the client asked to change), then today's results. `GET /api/v1/overview/teams/{id}` (the team's leads and deputies, admins, the owner): overdue callbacks, unassigned leads, emails waiting, then today's results. Who is available or on a call, and unanswered texts, come from the dialer (`GET /api/v1/status`, `GET /api/v1/sms/waiting?team_id=`). Days are the agency's time zone (`orgs.timezone`).
- `GET /api/v1/overview/members` (owner, admins): each member's last active day and days active this month.
- `POST /api/v1/reports/schedules {frequency: weekly|monthly, team_id, client_id, to_client}` (owner, admins; a team lead for their team, and to a client's people only for a client the team works for), `GET`, `DELETE /api/v1/reports/schedules/{id}`. Every 10 minutes due reports are emailed through the notification service (template `report`): calls, reached, appointments, deals won and their value for the last full week or month, with a link to the details, never a lead.

## Keys for outside tools and outgoing events (build step 33)

- `POST /api/v1/keys {name, scopes, team_id, project_id}` (owner, admins): scopes are only `leads:add`, `leads:read`, `deals:read`; nothing a key reaches calls, texts or spends. The key (`cwk_...`) is shown once and only its hash is kept. `GET /api/v1/keys`, `POST /api/v1/keys/{id}/off` and `/on`, `GET /api/v1/keys/{id}/uses`. A key stops working when its maker is no longer the owner or an admin.
- Tool routes (`Authorization: Bearer cwk_...`, open at the gateway, checked here): `POST /api/v1/tools/leads {leads: [{name, phone, email, note}]}` (up to 500, unassigned in the key's team and list), `GET /api/v1/tools/leads/{id}`, `GET /api/v1/tools/deals/{id}` (within the key's team and list). Every use is recorded, refused ones too.
- `POST /api/v1/hooks {url, events}` (the owner; https only; events `lead.booked`, `deal.won`) answers a signing secret once; `GET /api/v1/hooks` shows recent deliveries; `POST /api/v1/hooks/{id}/off`. Each message is `{event, id, lead_id, at}` and nothing else, signed `X-CallerWhale-Signature: sha256=HMAC(secret, timestamp + "." + body)` with `X-CallerWhale-Timestamp`; only public addresses are reached; a failure is retried after 1, 5, 30 minutes, 2 and 6 hours, then given up.

## Website forms (build step 36)

- `POST /api/v1/forms {name, title, client_id, team_id, consent_text, thanks, embed_origins}`, `PATCH /api/v1/forms/{id}` (also `off`), `GET /api/v1/forms`, `GET /api/v1/forms/{id}/submissions`: the owner and admins. The answer gives the form's `address` (`EMAIL_PUBLIC_URL` + `/api/v1/public/forms/<token>`) and an `embed` snippet. The consent words default to a draft for the lawyer.
- `GET /api/v1/public/forms/{token}` is the page (works in an iframe on the sites in `embed_origins`, or any site when empty; it allows nothing else), `POST` sends it. Each send becomes an unassigned lead of the form's client in its team (source "Form: <name>", the address and message as a note), checked against the block lists (a blocked number comes in as do-not-call and the submission is flagged), with whether the consent was ticked, its exact words, the time and the sender's network. A ticked consent lets the dialer text that number for that client (sent as `list_consent`). A hidden field turns robots away; 5 sends a minute per address per form.

## Sending a lead to another agency (build step 37)

All for the owner or an admin of each agency (`lead_referrals` sits outside either agency's rows; every read names the asking agency).
- `GET /api/v1/referrals/agencies?owner=Name#tag`: the agencies that person owns.
- `POST /api/v1/leads/{id}/send {to_org, note, consent_confirmed}`: the name, phone, email, property address and note go; the blocks on the number go with them. Calls, recordings, texts, notes, client data and consent to text stay. The sender's lead closes as "Sent to <agency>". `consent_confirmed` (the person agreed to be passed on) is required and kept with the date.
- `GET /api/v1/referrals`: sent (status, decline reason, fee, and the deal's close date only when both agencies agreed to share it) and received (contact details only while waiting or accepted).
- `POST /api/v1/referrals/{id}/accept {team_id, client_id}` (receiver): a new lead, "From <agency>", the note and address as a note; the sender's blocks come in locked, so `/api/v1/blocks/lift` refuses them. `/decline {reason}` (receiver) or `/cancel` (sender), while waiting, reopen the sender's lead (with the reason as a note).
- `POST /api/v1/referrals/{id}/fee {note}` or `{agree: true}` (owners): one side notes the agreed fee, the other agrees; when the deal is won, each owner gets a reminder task. `/share-close {agree}`: both must agree before the sender sees the close.
