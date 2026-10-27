# Positioning: a little cheaper, more included, honest about it

**Status:** Proposed
**Date:** 2026-10-27

## What we are aiming for

Turf is not the best tool in this market and the site should not say it is. The aim is narrower: **a little cheaper than the nearest alternatives, with more included, and a clear line between what we discount and what we do not.**

## What competitors charge (checked 2026-10-27)

Prices come from vendor blogs and review sites, which disagree with each other. Treat them as a guide and check each vendor's own pricing page before quoting any of them publicly. **None of these names or prices are on the landing site.**

| Tool | What the price buys | Reported price |
| --- | --- | --- |
| ReadyMode | Dialer with built-in CRM, unlimited outbound minutes, compliance tools. No list stacking or skip tracing | Starter $199 and iQ $249 per user a month (iQ adds caller ID reputation and number rotation) |
| REsimpli | CRM, lists, dialer and SMS in one app, with minute and text allowances | Basic about $149, Pro about $299 for up to 5 users, Enterprise about $599 for up to 10; extra users $79 to $89. Allowances are small (500 to 1,000 minutes on the lower plans). Some listings show $99 and $199 for older plans |
| Mojo | Dialer only | Single line $99 per license (plus $10 per user for agent access), triple line $139 to $159; skip tracing +$49, recording +$25 |
| BatchDialer | Dialer with 3 lines, 10 numbers, recordings, DNC and litigator scrubbing. No CRM | Starter $119 per agent, $95 billed annually |
| PropStream, DealMachine | Property data and lead lists, with their own skip tracing | PropStream $99 to $749; DealMachine $59 to $299 |

Dialer plus skip tracing plus recording from Mojo alone is about $180 a month for one person, and that still has no CRM, list handling or map.

## Where Turf's draft prices land

| Tier | Turf all-in price | Nearest comparison | Position |
| --- | --- | --- | --- |
| Solo (1 person) | **$179** a month | ReadyMode Starter $199; Mojo plus skip tracing and recording about $180; REsimpli Basic about $149 with small allowances | A little under the dialer-focused tools, and above REsimpli's entry plan because calling is unlimited (subject to fair use) and Skip tracing and the map are included |
| Duo (2 people) | **$288** for both | Two ReadyMode Starter seats $398 | About 28% under |
| Team (per person) | **$146** | ReadyMode $199 to $249; BatchDialer $119; REsimpli Pro about $60 per person for 5, with small allowances | Under ReadyMode, above the cheapest allowance-limited options |
| Pro (per person) | **$300** | ReadyMode iQ $249 | **Not cheaper, and not sold as cheaper** (decided 2026-10-27). Multi-line dialing makes calling minutes cost us about $135 per person, so Pro cannot undercut iQ without losing money. The site lists what Pro includes instead: multi-line dialing with voicemail drop, number rotation, custom roles, API access, scheduled and custom reports, higher limits, a 90-day recycle bin, point-in-time restore and a 2-year audit log |

The caps come from one rule, in `ALL_IN` in `landing/web/src/plan.js`: Solo $179, scaled by the same factor for the others.

## The rule on costs

**Discount the software, never the bills we pay.**

- The all-in price lowers only the software part of a feature: the margin above what it costs us to run.
- Calling, texts, phone numbers, number lookups, storage, map lookups and AI sending cost real money each month. They are priced at cost plus 25% (`USAGE_MARKUP`) and the all-in price cannot go below that. A test checks it for every mix of features and team size.
- **Extras are never discounted.** Texts ($15 per 1,000), campaign emails ($2 per 1,000), numbers ($1), number lookups ($10 per 1,000) and the other add-ons are outside the all-in price entirely.
- The metered cost per feature is in `COSTS` in `plan.js`, from the cost tables in `docs/features`. The CRM's storage (about $4 per person) is absorbed, because the CRM is a free base.

Unlimited calling is the exception that has no bill attached yet. It is only safe with a written and enforced fair-use limit.

## Tone for the site

- Say what Turf does and what is not built yet. No "best", "number one", "unmatched" or "only".
- Compare by category ("one app in place of several"), not by vendor. No competitor names or prices in public copy.
- Keep the honest-limits section on the Why Turf page (no new phone numbers yet, calling is not live, Windows first).
- Avoid absolutes about security and data. Say what is built and how, not that something can "never" happen.
