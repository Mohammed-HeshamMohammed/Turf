# ER diagrams – current CRM UI

Entity-relationship diagrams for every page of the Full CRM prototype in this folder. They are written in [Mermaid](https://mermaid.js.org/), which GitHub, VS Code (Markdown preview) and most Markdown viewers render.

The diagrams describe what the UI reads and writes today (`src/data.js`, `src/model.js`, `src/skiptrace-fields.js`), not the planned PostgreSQL schema in `../../backend`.

| File | Page | Route |
| --- | --- | --- |
| [00-master-er-diagram.md](00-master-er-diagram.md) | Every entity in one diagram, plus the shared top bar and menus | – |
| [01-overview-dashboard.md](01-overview-dashboard.md) | Overview | `#/dashboard` |
| [02-leads-list.md](02-leads-list.md) | Leads (List, Board, Map) | `#/work/leads` |
| [03-lead-detail.md](03-lead-detail.md) | Lead record | `#/work/leads/:id` |
| [04-new-lead.md](04-new-lead.md) | New lead | `#/work/leads/new` |
| [05-calls.md](05-calls.md) | Calls | `#/work/calls` |
| [06-deals.md](06-deals.md) | Deals | `#/work/deals` |
| [07-handoffs.md](07-handoffs.md) | Handoffs | `#/work/handoffs` |
| [08-tasks.md](08-tasks.md) | Tasks | `#/work/tasks` |
| [09-calendar.md](09-calendar.md) | Calendar | `#/work/calendar` |
| [10-inbox.md](10-inbox.md) | Inbox | `#/work/inbox` |
| [11-source-lists.md](11-source-lists.md) | Source lists | `#/lists` |
| [12-skip-tracing.md](12-skip-tracing.md) | Skip Tracing | `#/skip` |
| [13-team.md](13-team.md) | Team | `#/team` |
| [14-reports.md](14-reports.md) | Reports | `#/reports` |
| [15-settings.md](15-settings.md) | Settings | `#/settings/:section` |
| [16-sync.md](16-sync.md) | Sync and pending changes | `#/sync` |
| [17-personal-profile-and-preferences.md](17-personal-profile-and-preferences.md) | My profile and preferences | `#/personal/:section` |
| [18-sign-in-gate.md](18-sign-in-gate.md) | Server sign-in | full-screen gate |

## Conventions

- Boxes are arrays or objects inside the saved workspace state (key `callerwhale.full-crm.prototype.v1`). There is no database in sample mode.
- Computed or page-only entities (for example `SOURCE_GROUP`, `SKIP_RUN`, `CALENDAR_DAY`) are marked in each file as not stored.
- People are referenced by display name, so "FK" to `PERSON` means a name string.
- Roles decide which pages and records are visible. The route list per role is in `ROLES[...].pages` in `src/data.js`; the master diagram file summarises the rules.

## Role → pages

| Role | Pages |
| --- | --- |
| Business owner | dashboard, leads, calls, deals, handoffs, tasks, calendar, inbox, lists, skip, team, reports, settings |
| Team manager | dashboard, leads, calls, deals, handoffs, tasks, calendar, inbox, lists, team, reports, settings |
| Caller | dashboard, leads, calls, handoffs, tasks, calendar, inbox |
| Acquisitions / closer | dashboard, leads, calls, deals, handoffs, tasks, calendar, inbox, reports |
| Data researcher | dashboard, leads, lists, skip, tasks, reports |
| System administrator | dashboard, settings |
| Client / partner | dashboard, leads, tasks, inbox, reports |
| Solo operator | dashboard, leads, calls, deals, handoffs, tasks, calendar, inbox, lists, skip, reports, settings |

Sync and My account are open to every role.
