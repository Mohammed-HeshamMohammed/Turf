# Feature 7: Exports for other tools

**Status:** Written for review (2026-10-25)

## What exists today

In the Turf desktop app, Lists has two downloads beside the before / after CSVs (Feature 1):

- **Call list:** a CSV for a dialer, made from the list's Skip Tracing check. Each lead once, its best number in `Phone` and its other usable numbers in `Other phones`, with its stage, callback day and latest note. Leads with no number to call, repeats, and (unless asked for) leads that are not interested or dead are left out, and the message says how many.
- **Mail list:** a CSV for letters. Each owner once at where their mail goes (the same address however it is spelled), with the property it is about. It can be only absentee owners, only rows with no phone, and without PO boxes.

The CRM also exports the visible leads and reports as CSV, and reports as PDF (Feature 5).

## What the customer gets

| Export | For | Contents |
| --- | --- | --- |
| **Before / after list** | Keeping the original and the cleaned copy | Every row, original values, plus the check's columns (Feature 1) |
| **Call list** | Any outside dialer (ReadyMode, Mojo, CallTools…) | One row per lead, best phone first, other phones, stage, callback, latest note |
| **Mail list** | A mail house or letter service | One row per owner at the mailing address; filters for absentee, no phone, no PO boxes |
| **Leads view** | Spreadsheets, other CRMs | The leads and columns on screen, with the filters applied |
| **Reports** | Partners, accountants | CSV and PDF (Feature 5) |
| **Whole workspace** | Leaving Turf, or keeping a copy | Everything: see Feature 8 |

Later, as pushes instead of files: **send to a dialer** (ReadyMode, CallTools and others with an API) and **send to a mail house** (Lob, which Feature 6 already uses for postcards).

### Rules

- **The customer's own data is never held hostage.** Exports are unlimited on paid tiers: Turf does not charge to get the customer's data out. This is also what privacy laws expect.
- **Who may export follows the role** (Feature 1, teams): owners and managers export everything; researchers their lists; callers nothing; closers only their own deals. Every export is logged: who, what, when.
- **The free trial caps each export at 1,000 rows**, so the trial can't be used to clean big lists for free and leave.
- Exports leave out anything blocked: DNC and never-call numbers are dropped from call lists, opted-out addresses from mail lists, with the count shown.

## Where it runs

| Device | How |
| --- | --- |
| Desktop app | Made on the computer from the local copy; saved to Downloads (Feature 1's download handling) |
| Web app, old PC | Made on the server and downloaded; big exports run in the background and notify when ready |
| Phone | Started from the phone, made on the server, sent to the person's email or opened later on a computer |

## Where the data lives

Exports are **made on demand and never stored**, except a finished background export, which waits on the server for 7 days and is then deleted. The export log (who, what, when) stays with the workspace's audit log.

## What it costs Turf

| Item | Cost |
| --- | --- |
| Making an export on the desktop | $0 |
| Making an export on the server | A few CPU-seconds per 100,000 rows: ~$0 |
| Holding a background export for 7 days | Cloudflare R2, $0.015 per GB a month: ~$0 |
| Download traffic | Included in the VPS traffic / R2 has no download fees |

## Competition

| Tool | Export rule |
| --- | --- |
| DealMachine | **Each exported property and contact costs one data credit**; re-exporting the same record in a billing period is free. Plans include 10,000–20,000 credits per user. |
| PropStream | **25,000 / 50,000 saves and exports a month** ($99 / $199) |
| REsimpli, Carrot, HubSpot, Pipedrive | CSV export of CRM records; limits vary by plan |

PropStream and DealMachine meter exports because the records are **their data**. Turf's exports are the **customer's own leads**, so they stay unlimited. That is a selling point: "Turf never charges you to take your own leads to another tool."

Sources: [DealMachine export limits](https://help.next.dealmachine.com/en/articles/15902388-how-export-limits-work) · [DealMachine API exporting](https://api.docs.dealmachine.com/concepts/exporting) · [DealMachine current vs classic pricing](https://dealmachine.com/guides/current-vs-classic-pricing) · [PropStream pricing](https://www.propstream.com/news/how-much-does-propstream-cost)

## Amounts, cost and selling price

| | Free trial | Solo (1) | Duo (2) | Team (3+) | Pro (3+) |
| --- | --- | --- | --- | --- | --- |
| Before / after, call list, mail list, leads view, reports | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Rows per export** | 1,000 | Unlimited | Unlimited | Unlimited | Unlimited |
| Export log | ✅ | ✅ | ✅ | ✅ | ✅ |
| Send to a dialer / mail house (later) | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Cost to Turf** | ~$0 | ~$0 | ~$0 | ~$0 | ~$0 |
| **Selling price of this feature** | Free | **Included ($0)** | **Included ($0)** | **Included ($0)** | **Included ($0)** |

**Why $0:** charging to export the customer's own data would cost more in trust than it earns, and the costs are nothing. The value shows up as a reason to choose Turf over PropStream and DealMachine.
