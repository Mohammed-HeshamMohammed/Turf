# Turf — testing Full CRM mode

A separate interactive frontend prototype of [Turf's CRM and performance plan](../TURF_CRM_AND_PERFORMANCE_PLAN.md). It extends the current Turf design: Inter Tight, gray surfaces, rounded cards, black pill navigation, and peach accents.

The existing Turf app remains the primary application. This folder has its own package, dev server, source, sample records, and browser-storage key. It does not call Turf's Python service, Tauri commands, or any production API.

## Preview

The local preview runs at http://127.0.0.1:5190/ during this review session.

To reopen it later, run these commands from this folder:

```powershell
npm ci
npm run dev -- --host 127.0.0.1 --port 5190
```

Press the **Turf logo** to open the app menu and use **Explore as** to try all eight roles. The same menu provides workspace actions, connection controls, and reset. **Reset preview** restores the fictional sample workspace. Edits survive refresh in this browser under `turf.full-crm.prototype.v1`.

The sidebar toggle switches between full labels and a minimized icon rail. The preference survives refresh. Hovering an icon gently enlarges it and its neighbors while the rail bends outward; the selected item keeps a circular highlight. Tooltips also appear on keyboard focus. Reduced-motion preferences disable magnification and bending. Mobile retains the full-label drawer; role switching stays in the Turf logo menu.

The workspace identity sits beside Turf in the header. The avatar opens a separate personal menu with My profile, personal/notification preferences, My tasks, and Calendar when available. Personal profile details and notification preferences persist per sample account; editing a display name does not rename lead responsibility. My tasks filters by the account's canonical responsible person.

## Roles

| Role                  | Workspace and record scope                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business owner        | Organization-wide leads, deals, reports, data operations, and administration.                                                                     |
| Team manager          | Tampa team records, assignments, handoffs, tasks, conversations, and workflow previews.                                                           |
| Caller                | Maya's assigned leads, calling queue, callbacks, notes, outgoing handoffs, and conversations.                                                     |
| Acquisitions / closer | Alex's assigned leads and incoming handoffs; acceptance transfers responsibility and creates a deal.                                              |
| Data researcher       | Assigned Tampa project records, source lists, CSV import, contact evidence, and Skip Tracing review.                                              |
| System administrator  | Configuration, role presets, integrations, and planned services. No private CRM records.                                                          |
| Client / partner      | Explicitly shared properties, approved briefs, shared notes and tasks, and partner conversations. Seller SMS/email and team threads are excluded. |
| Solo operator         | All project workflows in one personal workspace.                                                                                                  |

These are frontend demonstration rules, not a security boundary. Every sample record is present in the local JavaScript app and role switching is unrestricted. Actual authentication, field redaction, tenant isolation, and authorization belong to the server implementation in the plan.

## Interactive workflows

- **Overview:** role-specific metrics, next conversations, task completion, lead-stage navigation, scoped global search, and task notifications.
- **Call activity chart:** 42 explicit illustrative intervals, six per day, with visible markers, day/time/count/reach-rate tooltips, keyboard navigation, and an accessible interval table. The sample daily totals are preserved; intermediate counts are sample data, not inferred production activity.
- **Personal account:** full-page profile editing and preferences, with task/unread-conversation switches that control the notification panel. All saves remain local to the preview.
- **Leads:** search and filters, list/board views, keyboard-accessible stage changes alongside drag and drop, bulk stage edits, assignment, full-page creation, callbacks, and internal/shared notes.
- **Lead record:** property context, activity history, source evidence, approved brief preview, and print support. All photos are explicitly illustrative.
- **Calls:** eligible sample queue, scripts, start/end simulated calls, outcomes, notes, and qualification handoff. No number is dialed and no microphone is used.
- **Handoffs:** request, review, accept, decline, and filter by status. Responsibility remains with the sender until acceptance. Acceptance is online-only and does not create duplicate deals.
- **Deals:** pipeline/list views, stage changes, offer amounts, expected fees, and target close dates. Deal amounts remain distinct from estimated property values.
- **Tasks and calendar:** full-page task creation, completion/reopening, priority, ownership, month navigation, and daily agenda.
- **Inbox:** scoped email, SMS, team, and explicitly shared partner threads; new conversations, unread state, local demo messages, and offline drafts. Attachments preview filenames only.
- **Lists:** source detail, CSV parsing/import, a sample import, and real CSV downloads of the visible data. Preview import is limited to 2 MB and 200 rows.
- **Skip Tracing:** the five-step Turf flow, local/cloud mode preview, configurable checks, simulated progress/cancel, review, saving a sample check, and CSV export.
- **Reports:** scoped totals, source/location breakdowns, stage distribution, CSV export, browser print/save PDF, and locally saved delivery schedules.
- **Sync:** offline preview, cached local edits, pending queue, sample conflicts, review/discard operations, and a simulated reconnect/sync. Another persona's operations are retained, and communication drafts are never automatically sent.
- **Settings:** workspace defaults, action permission overrides, workflow rule previews, communication connection previews, and the planned language/storage architecture.

## A useful walkthrough

1. Switch to **Caller**, open Sarah Johnson, and request a handoff to Alex with seller context.
2. Switch to **Acquisitions / closer**, open Handoffs, and accept it. Sarah is now assigned to Alex and has a deal.
3. Turn on **Offline preview**, add a note, and refresh. The note and pending operation remain.
4. Open Sync, reconnect, preview a conflict, keep the local change, and sync. A saved message draft remains unsent.
5. Switch to **Client / partner**. Sarah is shared, but internal notes, seller conversations, phone/email details, and deal financials are hidden in the interface.
6. Switch to **Data researcher**, try the sample CSV import, open it in Skip Tracing, run a demo check, and save the review.

## Prototype boundaries

- This is a runnable UI, not the completed CRM backend or native Turf mode. No VPS, Postgres, Redis, Rust, Python, Go, C, C++, provider adapter, or matching engine runs behind it.
- The language-service cards describe the plan only. Multithreading speedups and backend concurrency are not implemented or benchmarked here.
- Browser localStorage is unencrypted. The offline toggle simulates connectivity; it is not a service worker or guaranteed cold-start offline support. Use sample data for review.
- Sync removes eligible demo queue entries without uploading records. Conflict values are illustrative. Discarding a pending operation removes the queue entry; it does not roll back optimistic local values.
- Calls, recordings, messages, integrations, workflow execution, report delivery, and contact checks are explicitly simulated. No external communication is sent.
- Report periods illustrate the layout; totals represent the current visible snapshot, not historical date filtering. The dashboard trend is labeled illustrative. Display timezone is a saved preference; sample timestamps are fixed.
- Action permission overrides do not change a preset's navigation or record scope. Production roles need the plan's server-side grants and cache revocation.
- Source rows and entities are simplified. This does not implement the plan's complete people/property identity model, safe merge engine, document storage, or migration.

## Development and validation

```powershell
npm run lint
npm test
npm run build
```

Pure-model tests cover role boundaries, client message isolation, handoff ownership/idempotency, offline persistence, scoped synchronization, retained drafts/conflicts, and do-not-call blocking. The existing scaffold worker tests cover static routing and build packaging. Browser flow and visual evidence are recorded in [design-qa.md](design-qa.md).

Additional checks cover per-account profile persistence without changing record ownership, and interval totals matching the seven sample daily counts.

The scaffold hosting worker, build-preparation script, and `.openai/hosting.json` remain intact for a possible later Sites handoff. Nothing has been published to Sites.

## Source and asset notes

- Turf's existing `src/styles.css`, title bar, favicon, and live dashboard informed the visual system. The favicon is reused from Turf.
- `public/assets/property.jpg` was generated for this prototype with the image generation tool. It depicts a fictional house and is labeled as an illustrative sample photo.
- Icons come from Phosphor; charts from Recharts; CSV parsing from Papa Parse; the bundled font is Inter Tight Variable.
- Screenshot evidence contains the fictional preview workspace. The original Turf screenshot is stored outside the repository to avoid committing live workspace data.
