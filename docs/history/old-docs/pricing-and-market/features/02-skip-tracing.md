# Feature 2: Skip Tracing the customer's lists

**Status:** Agreed (2026-10-25)

## What the customer gets

Caller Whale's Skip Tracing **cleans and ranks the phone numbers a list already has**. It does not look up new numbers (that is Feature 1b, the supplier). One check does all of this:

- **Phone verdicts:** each number's quality (good, suspicious, bad) and, separately, its calling restrictions. Several numbers in one cell are ranked one by one, extensions are kept, and **the best number to call comes first, with the reason**.
- **Call-outcome evidence:** results from Caller Whale's own calls and from **other dialers' exports** (ReadyMode's call log is recognised as exported). Wrong numbers, disconnected numbers and do-not-call carry across every list.
- **Reading call statuses:** the customer's earlier decisions first, then phrase rules for dialer wording (LVM, NI, Disco…), then an AI model. A do-not-call status is never dropped on a guess.
- **Do Not Call:** numbers on the National Do Not Call Registry for the customer's area codes are blocked, plus Caller Whale's own never-call list.
- **NANPA number blocks:** numbers in unassigned or available blocks are marked suspicious.
- **Repeated leads:** households, LLCs, trusts and one owner with many properties are told apart, office lines are ignored, and the row with the best phone is kept.
- **Right-person check:** yes / no / unknown on whether a number belongs to the name on the customer's list, learned from confirmed calls across Caller Whale.
- **Caller Whale network hints:** "likely disconnected", "wrong number", "reached a person", learned from every Caller Whale customer's calls.
- **Number lookups:** line type and carrier, as credits. No API keys for the customer.
- **Review and overrule:** any answer can be overruled, and the decision is remembered. Original rows are never changed; checked copies stay downloadable before and after (Feature 1).

## Where it runs

Caller Whale picks automatically before each check, from the list's size and the device (cores, memory, a one-second speed test). The screen never freezes: work runs in the background, and a server check can be left running with the tab closed, with a notification when it is done.

| Device | Desktop app | Where checks run |
| --- | --- | --- |
| Windows 10 / 11 | ✅ | Desktop engine, any size, works offline |
| Mac | ✅ | Desktop engine, any size, works offline |
| Web app, good computer | — | **Browser engine** (WebAssembly in a background worker) up to ~50,000 rows; server above that |
| Web app, weak or old computer | — | Server |
| Phone / tablet | — | **Server, always.** Phones only view results. |
| Windows 7 / 8 / 8.1 | ❌ (WebView2 stopped at version 109 there) | Server, through the web app in Firefox 115 ESR (security updates until March 2027) |

The browser engine exists once the engine is ported to Rust (see the language plan). Until then, the web app sends every check to the server.

**Keeping the server from lagging** (2-vCPU KVM 2): one core stays reserved for the app and checks run on the other; small checks go first; each customer takes fair turns; when the queue backs up, a second worker server is added.

## Where the data lives

| Data / tool | Desktop | Server | Browser |
| --- | --- | --- | --- |
| The check engine | ✅ | ✅ worker | ✅ WebAssembly (later) |
| **Reading call statuses (AI)** | Rules only when offline | ✅ **always**, for every device | ❌ |
| **DNC registry** | ❌ | ✅ **one global copy**, filtered by each customer's SAN | ❌ (asks the server) |
| **Caller Whale never-call list** | Cached | ✅ global | ❌ (asks the server) |
| NANPA number blocks | ✅ | ✅ one shared copy (public data) | Small cached copy |
| The customer's call-outcome evidence | ✅ | ✅ source of truth | Their leads only |
| **Caller Whale network evidence** | ❌ | ✅ global | ❌ (asks the server) |
| **Right-person data** | ❌ | ✅ global, names stored scrambled | ❌ (asks the server) |
| **Number lookups** | ❌ | ✅ Caller Whale's Telnyx account, results cached ~90 days for everyone | ❌ |
| Status decisions, overrules | ✅ | ✅ source of truth | Cached |

### Do Not Call: global, filtered by SAN

Every business that calls must have **its own registry subscription and account number (SAN)**, paid for the area codes it calls. A provider may not buy the list once and share it with clients who have not paid. So:

- Caller Whale keeps **one global copy** of the registry on the server and refreshes it regularly. Customers no longer upload files.
- Each customer enters **their own SAN**, and Caller Whale blocks only against **the area codes that SAN has paid for**. The customer pays the FTC: the first 5 area codes are free, then $85 per area code a year (from October 2026).
- Caller Whale accesses the registry on each customer's behalf through their SAN. It downloads only the area codes its customers cover until the nationwide list ($23,425 a year) is worth buying.
- **Caller Whale's never-call list** (people who told any Caller Whale customer to stop) needs no SAN and applies to everyone.

### Network evidence: two layers

| Layer | Holds | Who sees it |
| --- | --- | --- |
| **The customer's own evidence** | Everything: reached, wrong person with the name, notes, dates | Only that customer. **Always wins.** |
| **Caller Whale network evidence** | Only facts about numbers: disconnected, wrong number, reached a person, with counts and the last date. **No names, notes, or which customer said it.** | Every customer, as a hint |

Network hints **fade with time**, since numbers get reassigned. "Wrong person" is never shared as a network fact, because it is tied to a name.

### Right-person check: learn, never reveal

- Learned **only from confirmed calls**: "Reached, right person" is evidence for a name and number; "Wrong person" is evidence against.
- **Names are stored scrambled (hashed).** Caller Whale can compare "SMITH JOHN A" with "John Smith" but cannot read names back out.
- The customer only ever sees **yes / no / unknown** for names already on their own list. No name from another customer is ever shown.
- Confirmations fade with time.

Showing names to customers would make Caller Whale a data broker (state registration, deletion requests) and could break customers' data licences. That stays out of this feature; a name-revealing product would be licensed data, as in Feature 1b.

**Required before launch:** the terms of service and privacy policy say Caller Whale learns from call outcomes across its network without names or notes, with an opt-out for customers who refuse. Have a privacy lawyer confirm Caller Whale stays a service provider.

## What it costs Caller Whale

| Part | Unit cost |
| --- | --- |
| Server checks | ~$0.001–0.002 per 1,000,000 rows (~5–10 minutes of one core; to be benchmarked on the VPS) |
| Status AI | ~$0 (small model, few distinct statuses per list) |
| DNC global copy | ~$0 in fees (the customer pays the FTC) + ~1–3 GB of disk |
| Never-call list, network evidence, right-person data | A few GB of disk in total: ~$0 |
| **Number lookups (Telnyx)** | **~$0.0015 landline, ~$0.004 mobile; $0 when served from the cache** |
| Extra worker server, when the queue needs it | ~$10–20 / month for another ~6–12 million rows an hour |

**Lookups are the only real cost.** The rest is close to free; the real limit is server capacity at busy times, handled by the queue and extra workers.

## Competition

| What | Who | Price |
| --- | --- | --- |
| Finding numbers (data lookup) | BatchSkipTracing, REISkip, BatchData | ~$0.02–0.15 per record |
| Phone statuses from dialer results | DataSift | No public price; one estimate is ~$300 per user / month |
| DNC scrubbing | Lead Sherpa | $100 / month standard, $750 / month unlimited |
| DNC flagging | PropStream | Free, only with its own skip tracing |
| Skip tool | Mojo | $49 / month |
| Line type lookups | Twilio / Telnyx / Trestle | $0.008 / ~$0.0015–0.004 / $0.015 per number |
| Right-person check | Trestle Real Contact / ActiveProspect | $0.03 / $0.025 per number |
| Litigator check | Trestle add-on | +$0.005 per number; others quote only |

**Where Caller Whale wins:** the right-person check is included (Trestle charges $0.03 a number, $300 for 10,000); DNC is handled with no file uploads; network hints from every Caller Whale customer's calls, which nobody else has; status reading, best-number ranking, smart repeats and overrules in one check; unlimited checks on the desktop and in the browser.

**Where they win:** they find new numbers. Feature 1b (the supplier) could close this.

Sources: [Who may access the DNC registry](https://telemarketing.donotcall.gov/faq/entity.aspx) · [SANs explained (DNC.com)](https://www.dnc.com/blog/what-businesses-need-to-know-about-sans-before-making-telemarketing-calls) · [FTC 2027 DNC fees](https://www.ftc.gov/news-events/news/press-releases/2026/08/ftc-announces-2027-telemarketer-fees-access-national-do-not-call-registry) · [Telnyx Number Lookup pricing](https://telnyx.com/pricing/number-lookup) · [Twilio Lookup pricing](https://www.twilio.com/en-us/lookup/pricing) · [Trestle pricing (FitGap)](https://us.fitgap.com/products/058256/trestle) · [Trestle Right Party Contact (ActiveProspect)](https://activeprospect.com/leadconduit/add-on-services/trestle/right_party_contact/) · [DataSift pricing (ITQlick)](https://www.itqlick.com/datasift/pricing) · [REISift phone statuses](https://intercom.help/reisift/en/articles/9267752-paano-magpalit-mula-sa-paggamit-ng-mga-tag-ng-telepono-patungo-sa-mga-katayuan-ng-telepono) · [Lead Sherpa DNC](https://leadsherpa.com/dnc-compliance) · [PropStream free DNC flagging](https://www.propstream.com/news/free-dnc-flagging-with-propstreams-skip-tracing-service) · [Skip tracing cost benchmarks](https://batchdata.io/blog/skip-tracing-cost-benchmarks) · [Mojo pricing](https://www.ringover.com/blog/mojo-dialer-pricing) · [Tauri webview versions](https://v2.tauri.app/reference/webview-versions/) · [WebView2 on Windows 7/8](https://learn.microsoft.com/en-us/answers/questions/1216969/what-is-the-minimum-version-of-webview2-runtime-th) · [Firefox on Windows 7, 8 and 8.1](https://support.mozilla.org/en-US/kb/firefox-users-windows-7-8-and-81-moving-extended-support) · [WebAssembly memory in Safari](https://www2.webkit.org/show_bug.cgi?id=221530)

## Amounts, cost and selling price

This prices **the feature**, not the plans. The tier names are labels only.

| | Free trial | Solo (1) | Duo (2) | Team (3+) | Pro (3+) |
| --- | --- | --- | --- | --- | --- |
| **Checks on the desktop / in the browser** | Unlimited | Unlimited | Unlimited | Unlimited | Unlimited |
| **Rows checked on the server per month** | 25,000 | 1,000,000 | 2,000,000 shared | 1,000,000 per seat, shared | 3,000,000 per seat, shared |
| Status AI, DNC, never-call list, network hints | ✅ | ✅ | ✅ | ✅ | ✅ |
| Right-person check | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Number lookups included per month** | 100 | 1,000 | 2,000 shared | 1,000 per seat, shared | 3,000 per seat, shared |
| **Cost to Caller Whale, fully used** (no cache hits) | ~$0.40 | ~$4 | ~$8 | ~$4 per seat | ~$12 per seat |
| **Selling price of this feature** | Free | **$79 / month** | **$119 / month** for both | **$59 per seat / month** | **$89 per seat / month** |
| **Margin when fully used** | — | ~95% | ~93% | ~93% | ~86% |

**Extra number lookups:** **$10 per 1,000**. Cost to Caller Whale: $1.50–4, falling as the cache grows.

**Why these selling prices:** DNC scrubbing alone is $100 / month at Lead Sherpa, and right-person checks on 3,000 numbers would cost $90 at Trestle. Caller Whale does both and more for $79. It is priced above Feature 1 ($49) because it is what directly raises the contact rate.
