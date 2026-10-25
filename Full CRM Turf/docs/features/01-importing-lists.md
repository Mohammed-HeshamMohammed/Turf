# Feature 1: Importing lists (local and server)

**Status:** Agreed (2026-10-25)

## What the customer gets

- **Import any list** (county exports, PropStream, any CSV up to 50 MB, every row kept), with smart column mapping.
- **Processing is Turf's job and is never counted:** importing, merging repeats, sorting, Skip Tracing and re-running checks are unlimited.
- **Before and after, any time:** every list can be downloaded as it was imported (before) or as Skip Tracing left it (after). The original data is never changed.
- **Two places to keep lists:**
  - **On the computer (desktop app):** unlimited, works offline, costs Turf nothing.
  - **On the server:** needed for sharing with the team and for the web app. Limited by the plan's **active leads**.

> "Your original data is never changed. Download any list before or after Skip Tracing, any time."

## What counts against the plan

Only **active leads** on the server count:

- **Unique leads after deduplication.** A 10,000-row list that cleans down to 6,500 real leads counts as 6,500. A lead on several lists counts once.
- **Before and after are one lead with two views**, not two leads.
- **Archived lists don't count.** A finished list can be archived (compressed, reopened any time).
- **The uploaded CSV file doesn't count.** The server keeps it 30 days (to redo a bad import), then keeps only the leads, which already hold every original value.

Over the limit, **nothing is deleted**. New server uploads pause, local import and archiving still work, or the customer buys more.

## Where the data lives

The server always holds **one copy** of a team's list, however many people work it. Each person's computer holds only their part.

| Data | Server | Owner / Manager computer | Caller / Closer computer |
| --- | --- | --- | --- |
| Uploaded CSV file | 30 days | ✅ kept | ❌ |
| Original values (before) | ✅ one copy | ✅ | ❌ |
| Latest Skip Tracing result (after) | ✅ one copy | ✅ | ✅ only their leads |
| Skip Tracing working data (pairs, evidence, scores) | ❌ when run on desktop | ✅ while running | ❌ |
| Lead work: stage, notes, calls, callbacks, tasks, assignment | ✅ source of truth | ✅ offline copy | ✅ only their leads |
| Previous Skip Tracing run | ✅ compressed | ✅ | ❌ |
| Older runs | ❌ | ✅ | ❌ |
| Downloads (CSV) | Made on demand, never stored | Made on demand | — |
| Map tiles, caches | ❌ | ✅ | ✅ |
| Personal lists never shared | ❌ | ✅ unlimited | ✅ unlimited |

Rules:

1. **A list shared with the team lives on the server.** A list only on someone's computer can't be assigned.
2. **Skip Tracing runs on the desktop by default.** Server Skip Tracing is for web-only users.
3. **A caller's or closer's local copy** holds only their leads, is encrypted, and is removed when the leads are taken away or they leave the team.

## What it costs Turf

**Example team:** owner + 4 callers importing a 10,000-row list every working day (~220,000 rows a month), cleaning down to ~150,000 unique leads.

| Cost | Per month | Notes |
| --- | --- | --- |
| Database storage | ~0.5–0.7 GB added | ~3 KB per lead with indexes |
| Backups | ~1.5–2 GB | 2–3 copies |
| Disk cost | ~$0.20–0.40 | VPS disk at roughly $0.10–0.20 per GB-month |
| Sync to callers | ~110 MB each the first time, then small daily changes | Included in the VPS traffic allowance |
| Skip Tracing on desktop | $0 | Runs on the customer's computer |
| Skip Tracing on server (if used) | ~20–30 CPU-minutes | Pennies, but it slows a 2-vCPU server while it runs |
| **Total** | **Under $1 per team** | |

The real limit is **capacity on one server** (disk size, database speed, CPU during server Skip Tracing), not money. The active-lead caps and archiving are capacity guards. Plan to move the database to its own server at roughly 50 heavy customers.

## Competition

| Tool | How it handles lists | Limit | Starting price |
| --- | --- | --- | --- |
| **DataSift (formerly REISift)** | List stacking is its core; stacks automatically on upload | ~25,000 records on the entry plan (older plan), then $5 per extra 10,000 | Not confirmed for 2026 |
| **REsimpli** | Import, stacking, address-based deduplication, skip tracing | ~20,000 records on entry; unlimited on top plan | ~$149–199/mo |
| **PropStream** | Stacking on its own data | 25,000–50,000 saves/exports a month | $99 / $199 |
| **BatchLeads** | Stacking and deduplication, mostly on its own data | Per plan | ~$119/mo |
| **DealMachine** | Stacking on its own data, credits | 10,000–20,000 credits per user | $99–149/user |
| **Propwire** | Basic deduplication, pay per skip trace | — | Free data, paid tracing |

PropStream, BatchLeads and DealMachine **sell the data**, so their limits protect a data bill. With Turf the customer brings the list, so the only cost is storage. DataSift and REsimpli are the fair comparisons.

**Where Turf wins:** unlimited on the desktop and 1,000,000 active leads per seat on the server (against ~20,000–25,000); processing never counted; deduplication that tells households, LLCs, trusts and one-owner-many-properties apart; before and after downloads; works offline; imports call outcomes from other dialers.

**Where they win today:** they sell data inside the app (Feature 1b could close this), they find phone numbers Turf doesn't, and they are proven products.

> "Stack and clean unlimited lists on your computer, and 1,000,000 leads for your team, for $150."

Sources: [REISift list stacking](https://intercom.help/reisift/pt-BR/articles/4364638-como-encontrar-registros-de-propriedades-stackadas) · [REISift upload limits](https://intercom.help/reisift/en/articles/9114372-limitasyon-sa-pag-upload-at-paano-bumili-ng-karagdagang-espasyo) · [REsimpli pricing](https://www.resimpli.com/pricing) · [List stacking software (REsimpli)](https://resimpli.com/blog/list-stacking-software/) · [Tools to pull lists in 2026 (REsimpli)](https://resimpli.com/blog/tools-to-pull-lists-for-real-estate-investors-in-2026/) · [PropStream pricing](https://www.propstream.com/news/how-much-does-propstream-cost) · [DealMachine pricing](https://dealmachine.com/guides/current-vs-classic-pricing) · [Pipedrive usage limits](https://support.pipedrive.com/article/usage-limits-in-pipedrive)

## Amounts and prices by plan

| | Free trial | Solo | Team | Pro |
| --- | --- | --- | --- | --- |
| **Plan price** | Free, 7 days | $150 / month | $129 per seat / month | ~$229–249 per seat / month |
| **Lists on the computer** | Unlimited | Unlimited | Unlimited | Unlimited |
| **Active leads on the server** | 25,000 | 1,000,000 | 1,000,000 per seat, shared by the team | 2,500,000 per seat, shared by the team |
| **Processing** (import, dedup, Skip Tracing, re-runs) | Unlimited | Unlimited | Unlimited | Unlimited |
| **Before / after downloads** | ✅ | ✅ | ✅ | ✅ |
| **Archiving finished lists** | ✅ | ✅ | ✅ | ✅ |
| **Uploaded CSV kept on the server** | 30 days | 30 days | 30 days | 30 days |
| **Price of this feature** | Included | Included in the $150 | Included in the $129 per seat | Included in the Pro price |
| **More active leads** | Upgrade to a paid plan | +500,000 for $10 / month | +500,000 for $10 / month | +500,000 for $10 / month |

The add-on costs Turf roughly $0.15–0.30 a month in storage, so it is almost all margin. Its size and price are a proposal: confirm when the Pro plan is settled.
