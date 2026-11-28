# Feature 5: The CRM

**Status:** Agreed (2026-10-25)

Lists, Skip Tracing, calling and the map are Features 1–4. This feature is **everything that runs the work around the lead**.

## What the customer gets

| Part | What it does |
| --- | --- |
| **Overview** | A greeting with active leads, open next steps, open handoffs and pipeline value. **"Needs you today"** lists due tasks, callbacks and unread replies, each with its one action. Also a "good next conversation" card, the call activity chart, team activity, upcoming tasks, deals closing soonest and lead stages. |
| **Leads** | List and board views (the map is Feature 4), filters by stage and person, export, new lead, sortable and movable columns |
| **Lead page** | Tabs for Overview, Activity, Location, Documents and Evidence. Property details, value, best phone, responsible person, **internal and shared notes**, next step (stage, callback date and time), tasks, deals and contact. A record version for sync. |
| **Deals** | Pipeline and list. Stages: Qualified, Appointment, Offer preparation, Offer sent, Negotiation, Under contract, Closed won, Closed lost. Amounts, expected fees, close dates. |
| **Tasks** | Priority, owner, type (callback, offer, appointment, document), due date and time, done or reopened |
| **Calendar** | Month view with a daily agenda, in the workspace time zone |
| **Handoffs** | Caller → closer: request, accept or decline, with notes. **Ownership moves only on acceptance.** |
| **Inbox** | Email, SMS (Feature 3), team and partner threads, on the lead, with attachments |
| **Team** | Each person's leads, open steps, calls logged, handoffs waiting and pipeline; unassigned leads flagged |
| **Reports** | Totals, which sources produce conversations, lead progression, CSV export, PDF, scheduled reports |
| **Settings** | Workspace name, time zone, daily outreach goal, members, **follow-up rules** (no answer → callback in 2 days; handoff waiting 24 hours → tell the manager; qualified → start an acquisition task), per-action permissions, connections (Google Workspace, custom provider) |
| **Roles** | Owner, manager, caller, closer, researcher, administrator, client/partner and solo, each seeing only its part |
| **Sync / offline** | Pending changes, conflicts to decide, offline mode, encrypted offline copy |
| **My account** | Profile, photo, email change with verification, notification preferences |
| **Client / partner sharing** | Partners see only what is shared with them: approved property briefs, shared notes and tasks, partner threads |

## What's real today

| Part | Status |
| --- | --- |
| Every screen above | 🟡 Built as a demo with sample data in the browser |
| Server: sign-in, Google sign-in, roles and permissions, CRM records, sync, follow-up rules (Go worker), reports, billing | ✅ Built (Rust API + PostgreSQL); the demo can connect to it |
| Email sync (Gmail, Outlook) | ❌ Not connected |
| Documents and attachments | 🟡 A server storage route exists; the demo shows file names only |
| Scheduled reports actually sending | ❌ Saved only |
| Notifications by email or push | ❌ In-app only |

## Where it runs

| Device | How the CRM runs |
| --- | --- |
| Windows 10/11, Mac (desktop app) | Full app. **Works offline**: the person's part of the records is cached and encrypted, edits queue up and sync when back online. |
| Web app, any computer | Full app, online. An offline copy only if the person sets an unlock passphrase. |
| Old PC, Windows 7/8 (Firefox 115 ESR) | Full app, online. Long lists page from the server, so a weak PC never holds them all. |
| Phone | Day-to-day work: today's tasks, callbacks, the lead page, notes, inbox, handoffs. Heavy screens (reports, settings, big boards) are simplified. |

## Where the data lives

| Data | Server | Device |
| --- | --- | --- |
| Leads, deals, tasks, notes, handoffs | ✅ **source of truth**, checked against each role | ✅ cached, **only what the role can see**, encrypted |
| Changes made offline | ✅ applied in order, each with a unique id so nothing applies twice | ✅ queued until online |
| Live updates ("Alex accepted your handoff") | ✅ pushed to everyone online at once | Shown live |
| Follow-up rules and automation | ✅ run on the server only, logged, safe to retry | ❌ |
| Reports | ✅ built on the server | Viewed; exports made on demand |
| **Documents** (contracts, photos, IDs) | ✅ stored per workspace | Opened on demand; the desktop can keep copies offline |
| Email threads | ✅ synced from Gmail / Outlook | Their own threads, cached |
| Permissions, roles, audit log | ✅ only | ❌ |

## What it costs Caller Whale

| Item | Option | Cost |
| --- | --- | --- |
| Leads, deals, tasks, notes, handoffs | Database rows (as in Feature 1) | ~$0 |
| **Documents** | Cloudflare R2 storage, no download fees | **$0.015 per GB a month** (first 10 GB free) |
| Notification and report emails | Amazon SES | ~$0.10–0.16 per 1,000 emails |
| Push notifications | Browser push / Apple / Google | $0 |
| Email sync | Gmail and Microsoft APIs | $0 (attachments count as documents) |
| Live updates, follow-up rules, reports | Server CPU | ~$0.10–0.30 per seat a month (estimate) |

**Documents are the only cost that grows**, and even 100 GB is $1.50 a month. The real cost of a CRM is **support time**, not servers.

## Competition

| Tool | Type | Price |
| --- | --- | --- |
| REsimpli | Real-estate investor CRM, all-in-one | $199 / month (1 user), $499 / month (5 users); extra users $99; documents 50 / 200 / 500 GB, extra 50 GB $5 |
| InvestorFuse | Real-estate investor CRM | Quote only; no free trial |
| Podio | Build-your-own, popular with investors through templates | ~$11.20–19.20 per user (annual); templates and add-ons extra |
| DealMachine | Data + CRM | $99–149 per user, CRM included |
| Follow Up Boss | Real-estate agent CRM | $69 / user ($58 annual); Pro $499 for 10 users (+$49 each); Platform $1,000 for 30 users |
| Pipedrive | General sales CRM | $14–79 per seat (annual); extra packs $50 |
| HubSpot Sales Hub | General CRM | $20 / $90 / $150 per seat, plus $1,500 / $3,500 onboarding; view-only seats free |

**Where Caller Whale wins:**

- Built around property outreach: caller → closer handoffs that move ownership only on acceptance, acquisition deal stages, and 8 roles that match real teams.
- Follow-up rules driven by call outcomes (Feature 3), where general CRMs need setup and add-ons.
- Free client and partner seats with a partner view. HubSpot gives free view-only seats; most real-estate tools don't.
- Works offline on the desktop with an encrypted copy. None of them do.
- One app with Features 1–4. REsimpli is the only other all-in-one, at $199.
- No onboarding fee, where HubSpot charges $1,500–3,500.

**Where they win today:** integrations and app marketplaces (HubSpot, Pipedrive, Follow Up Boss); email marketing campaigns (HubSpot) and seller websites (Carrot, REsimpli); mature mobile apps (Follow Up Boss); e-signatures and transaction management (REsimpli, InvestorFuse). AI email and messaging campaigns are planned as their own feature.

Sources: [REsimpli pricing](https://www.resimpli.com/pricing) · [InvestorFuse (Capterra)](https://www.capterra.com/p/239158/InvestorFuse/) · [InvestorFuse (G2)](https://g2.com/products/investorfuse/reviews) · [Podio pricing (Lark)](https://www.larksuite.com/en_us/blog/podio-pricing) · [Podio G-Cloud price list 2026](https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-15/documents/92220/669929261761805-pricing-document-2026-01-26-0035.pdf) · [DealMachine pricing](https://dealmachine.com/guides/current-vs-classic-pricing) · [Follow Up Boss pricing 2026 (CloudTalk)](https://www.cloudtalk.io/blog/follow-up-boss-pricing/) · [Follow Up Boss pricing (Luxury Presence)](https://www.luxurypresence.com/?p=43368) · [HubSpot vs Pipedrive 2026 (Apexure)](https://www.apexure.com/blog/hubspot-vs-pipedrive) · [Pipedrive pricing 2026](https://leadhaste.com/blog/pipedrive-pricing-2026) · [Cloudflare R2 pricing 2026](https://filebase.com/blog/cloudflare-r2-pricing-costs-savings-and-alternatives-in-2026/) · [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) · [Postmark pricing 2026](https://automationatlas.io/answers/postmark-pricing-explained-2026/)

## Amounts, cost and selling price

This prices **the feature**, not the plans. The tier names are labels only.

| | Free trial | Solo (1) | Duo (2) | Team (3+) | Pro (3+) |
| --- | --- | --- | --- | --- | --- |
| Overview, leads, lead page, deals, tasks, calendar, inbox | ✅ | ✅ | ✅ | ✅ | ✅ |
| Handoffs, team page, roles | — | — | ✅ simple (both see everything) | ✅ 8 roles | ✅ 8 roles + **custom roles** |
| **Client / partner seats** | — | Unlimited, free | Unlimited, free | Unlimited, free | Unlimited, free |
| **Document storage** | 1 GB | 25 GB | 50 GB shared | 25 GB per seat, shared | 100 GB per seat, shared |
| **Follow-up rules** | 3 | 10 | 20 | 25 | Unlimited |
| **Reports** | Basic | Basic + CSV / PDF | Basic + CSV / PDF | + scheduled reports | + scheduled + custom reports |
| Email sync (Gmail / Outlook) | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Offline (desktop)** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **API access** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Cost to Caller Whale, fully used** | ~$0.05 | ~$0.70 | ~$1.20 | ~$0.70 per seat | ~$2 per seat |
| **Selling price of this feature** | Free | **$49 / month** | **$79 / month** for both | **$45 per seat / month** | **$59 per seat / month** |
| **Margin** | — | ~99% | ~98% | ~98% | ~97% |

**More documents:** +100 GB for **$5 a month** (cost $1.50), the same as REsimpli's extra-storage price for double the space.

**Why these selling prices:** general CRMs run $14–90 per seat, and the real-estate ones charge $58–99 per user (Follow Up Boss $58–69, REsimpli $99 per extra user). $45–59 puts Caller Whale's CRM in the middle while it is built for property outreach, which Pipedrive and HubSpot are not. Margins are high because the costs are tiny; the price also pays for support time, which is the real cost of a CRM.
