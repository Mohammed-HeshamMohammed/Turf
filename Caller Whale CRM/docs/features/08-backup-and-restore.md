# Feature 8: Backup and restore

**Status:** Written for review (2026-10-25)

## What exists today

In the Caller Whale desktop app:

- **Deleting a list sets it aside for 30 days.** *Deleted lists* puts it back with everything it had (rows, setup, checks and the stored file), or deletes it for good. A list deleted more than 30 days ago is let go the next time the project is opened.
- **Back up this project** writes one zip with the project's database and every stored file. Unpacked into an empty folder, it opens as the project.

In the CRM, reversible removals (archive a lead, delete a task or note) happen at once with **Undo**; permanent removals ask first. The server has no backup plan written down yet.

## What the customer gets

| Part | What it does |
| --- | --- |
| **Undo and recycle bin** | Deleted lists, leads, deals, tasks and notes wait in a bin and can be put back, for 30 days (90 on Pro) |
| **Download everything** | One zip of the whole workspace: every record as CSV and JSON, every document, the call logs and the settings. Available at any time, including after cancelling (for 30 days). |
| **Desktop backups** | The project zip (as today), plus **automatic local backups** each day, keeping the last 7 |
| **Caller Whale's server backups** | Caller Whale backs up every workspace continuously; the customer never has to think about it |
| **Restore to a point in time** | If something goes badly wrong (a bad import, a team member deleting in bulk), support restores the workspace to how it was at a chosen moment |

### How Caller Whale backs up the server

| What | How | Kept |
| --- | --- | --- |
| Database (PostgreSQL) | **Continuous archiving** of every change plus a nightly full copy, stored off the VPS in Cloudflare R2 | 30 days of point-in-time history; monthly copies for 12 months |
| Documents | Stored in R2 with **versioning**, so an overwritten or deleted file can be brought back | 30 days of old versions (90 on Pro) |
| Off-site rule | Backups never live only on the VPS. If the VPS disappears, the workspace can be rebuilt on a new one | — |
| **Restore drill** | A backup is restored into a test server every month to prove it works | — |

Restoring one workspace without touching others is done by restoring into a separate database and copying that workspace's rows back; row security already keeps every workspace's rows apart.

## Where it runs

| Device | What the person does |
| --- | --- |
| Desktop app | Recycle bin, download everything, project zip, automatic local backups |
| Web app, old PC, phone | Recycle bin and download everything; the zip is made on the server and sent as a link |
| Server | Continuous backups, nightly copies, restore drills, point-in-time restores |

## Where the data lives

| Data | Where |
| --- | --- |
| Recycle bin | Server (marked deleted, not removed) and the desktop project |
| Server backups | Cloudflare R2, encrypted, separate from the VPS |
| Download-everything zip | Made on demand; the link works for 7 days |
| Desktop backups | The customer's own computer |

## What it costs Caller Whale

| Item | Cost |
| --- | --- |
| Backup storage | Cloudflare R2 at $0.015 per GB a month. Backups take roughly 3× the database size, so a busy seat with 2–3 GB of data costs ~$0.10–0.15 a month. |
| Document versions | ~20% more document storage: cents |
| Restore drills | A test server for a few hours a month: ~$1–2 total, not per customer |
| Point-in-time restores | **Support time**, the real cost. Self-serve undo covers most cases. |

## Competition

| Tool | Backup and restore |
| --- | --- |
| Most CRMs (HubSpot, Pipedrive, real-estate CRMs) | A recycle bin for recently deleted records (commonly 30–90 days) and CSV export |
| Salesforce | Backup and restore is sold as a separate paid add-on, and many customers buy third-party backup tools |
| Real-estate CRMs | Full point-in-time restore is not advertised |

**Where Caller Whale wins:** a recycle bin for lists, leads, deals, tasks and notes; one-click "download everything"; automatic local backups on the desktop; point-in-time restore included rather than sold as an add-on; data available for 30 days after cancelling.

Sources: [Cloudflare R2 pricing 2026](https://filebase.com/blog/cloudflare-r2-pricing-costs-savings-and-alternatives-in-2026/). Competitor recycle-bin windows were not checked against each vendor's pages and should be confirmed before quoting them.

## Amounts, cost and selling price

| | Free trial | Solo (1) | Duo (2) | Team (3+) | Pro (3+) |
| --- | --- | --- | --- | --- | --- |
| Undo + recycle bin | 7 days | 30 days | 30 days | 30 days | 90 days |
| Download everything | ✅ | ✅ | ✅ | ✅ | ✅ |
| Desktop automatic backups | ✅ | ✅ | ✅ | ✅ | ✅ |
| Caller Whale's server backups | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Point-in-time restore by support** | ❌ | Last 14 days | Last 14 days | Last 30 days | Last 30 days, priority |
| Document versions kept | 7 days | 30 days | 30 days | 30 days | 90 days |
| **Cost to Caller Whale** | ~$0 | ~$0.15 | ~$0.25 | ~$0.15 per seat | ~$0.30 per seat |
| **Selling price of this feature** | Free | **Included ($0)** | **Included ($0)** | **Included ($0)** | **Included ($0)** |

**Why $0:** backups are part of being trustworthy with someone's business, and they cost cents. Pro's longer windows and priority restores are a reason to upgrade, not a separate charge.
