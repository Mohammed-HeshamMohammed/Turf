# Feature 3: Dialer, auto dialing, SMS and call logs

**Status:** Agreed (2026-10-25)

## What exists today

- **Caller Whale desktop app:** the call button is a `tel:` link, so Windows hands the call to another app. There is no calling inside Caller Whale.
- **CRM demo:** a dial pad, call queue, start/end, outcomes and an SMS box, all **simulated**.
- **Server:** the tables are ready (`call_sessions`, `messages`, minutes billed per call) but not connected to a carrier.

All of it becomes real calling through **Telnyx**, inside the app, with nothing tied to Windows.

## What the customer gets

### 1. Dial pad (manual calls)

- The caller dials or clicks a number and **the call runs inside Caller Whale**, through the browser's built-in calling (WebRTC).
- The audio goes between the caller's headset and Telnyx. Caller Whale's server only issues a short-lived call token and logs the call. The Telnyx account key never reaches the browser.
- **"Call me first"** for weak PCs, bad internet or no headset: Caller Whale rings **the caller's own cell phone**, then connects it to the lead. The computer only shows the screen, so even a very old PC works.

### 2. Auto dialing (lists)

**It runs on Caller Whale's server**, not on the caller's device. The server dials, listens, and connects the caller's audio only when a person answers, so a weak PC never carries more than one call.

| Mode | How it works | Legal |
| --- | --- | --- |
| **Power (1 line)** | Dials the next lead the moment the caller is free | Zero abandoned calls. The default. |
| **Multi-line (2–3 lines)** | Dials several at once; the first person to answer gets the caller | Federal rule: **under 3% of answered calls abandoned** per campaign over 30 days. A person must be connected **within 2 seconds** of their greeting, or a recorded message plays with the caller's name and a callback number. Caller Whale tracks this live and slows down automatically. |

Every auto-dialed call gets:

- **Voicemail detection** on the server, and the option to **drop a pre-recorded voicemail** without the caller waiting.
- **A check before each dial:** DNC and the never-call list (Feature 2), **calling hours in the lead's time zone**, and state rules.

### 3. SMS

- Sent and received **through Caller Whale's server**, shown in the **Inbox** on the lead's thread.
- **Every customer must be registered for business texting (10DLC):** their business and each campaign type. Unregistered texts have been **blocked by US carriers** since February 2025. Caller Whale registers each customer as their software provider.
- **STOP / opt-out** comes from the carrier and is mirrored into Caller Whale. Caller Whale never texts an opted-out number again.
- **Cold texting property owners is the riskiest part.** Marketing texts to cell phones generally need the person's prior written consent, and carriers often reject cold-outreach campaigns. SMS launches for **replies and follow-ups with people who have engaged**. Cold texting waits for a lawyer's sign-off.

### 4. Call logs

Every call and text is logged:

- Who called, the lead, the number used and the number dialed.
- Direction, start, end, duration and minutes billed.
- Outcome (reached, voicemail, no answer, wrong number…) and notes.
- Recording, if on, and later a transcript (AI feature).

Each outcome **feeds Feature 2 automatically**: the customer's own evidence and the Caller Whale network hints.

**Recording law:** Florida and several other states require **everyone on the call to agree** to recording. Caller Whale plays a short notice ("this call may be recorded") or lets the customer turn recording off per state.

### 5. Phone numbers and reputation

- Customers rent numbers through Caller Whale, local to the lead's area code if they want.
- Telnyx owns the numbers, so calls carry the **top caller-ID trust rating (A attestation)**, which carriers use when deciding whether to label a call "Spam Likely".
- **Number health:** Caller Whale watches answer rates per number and flags a number that looks labelled. **Rotation** rests flagged numbers and spreads calls across several.

## Where it runs

| Device | Dial pad | Auto dialing | SMS / logs |
| --- | --- | --- | --- |
| Windows 10/11, Mac (desktop app) | In-app calling | Server; the caller's audio in the app | ✅ |
| Web app, any computer | In-app calling in the browser | Server | ✅ |
| Old or weak PC, Windows 7/8 (Firefox 115 ESR) | In-app calling (light on CPU), or "call me first" | Server, with audio on the caller's cell phone if needed | ✅ |
| Phone browser | "Call me first" recommended (mobile browsers drop calls when the screen locks) | Server, audio on the caller's cell phone | ✅ |
| Native mobile app (later) | Real phone calls with the iPhone / Android call screen (Telnyx mobile SDKs) | Server | ✅ |

## Where the data lives

| Data | Server | Caller's device |
| --- | --- | --- |
| Call tokens, the Telnyx account | ✅ only | ❌ |
| Auto-dial queue, pacing, abandonment tracking | ✅ only | ❌ (shows the queue) |
| Call logs | ✅ source of truth | ✅ their own calls, cached |
| Recordings | ✅ (Telnyx stores them; Caller Whale keeps the link) | ❌ streamed when played |
| SMS threads | ✅ source of truth | ✅ their leads, cached |
| Opt-outs, DNC, calling hours | ✅ checked before every call and text | ❌ |
| Voicemail drop recordings | ✅ | ❌ |

## What it costs Caller Whale

Telnyx list prices, before volume discounts and taxes.

| Item | Cost |
| --- | --- |
| Call minute, in-app (carrier ~$0.007 + in-app leg ~$0.002) | **~$0.009 / min** |
| Call minute, "call me first" (two phone legs) | ~$0.014 / min |
| Recording | +$0.002 / min |
| Voicemail detection | $0.002 per answered call (premium $0.0065) |
| Phone number | ~$1–2 / month (check Telnyx's current rate) |
| Text, sent or received (Telnyx ~$0.004 + carrier ~$0.003) | **~$0.007** |
| Texting registration (10DLC) | $4.50 brand + $15 campaign review once; $1.50–10 / month per campaign |
| Server work (queue, logs, pacing) | ~$0 |

**Minutes are the real cost**: about $0.011 a minute with recording. A "call me first" minute counts as **1.5 minutes** against the plan.

**What a full-time caller uses:** ~1,500–3,000 minutes a month with manual or power dialing; ~7,800 minutes and ~13,000 voicemail checks a month with 3-line auto dialing.

## Competition

| Tool | Per user / month | Auto dialing | Voicemail skip / drop | SMS | Built-in CRM | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| ReadyMode | $199 Starter / $249 iQ | Multi-line, predictive | ✅ | ✅ | Basic | Teams of 5+ may need iQ; inbound costs extra |
| Mojo | $10 access + $89 (1 line) / $139 (3 lines) | 1 or 3 lines | ✅ (3-line) | ❌ | Basic | Recording +$25; data and skip tracing extra |
| BatchDialer | $95–199 (annual) | Multi-line | ✅ | ✅ | ❌ | Unlimited calling |
| PhoneBurner | $140 / $165 / $183 (annual); $165–215 monthly | Single line only | ✅ | Only on $183 Premium | Light | Transcripts and AI notes only on Premium |
| CallTools | ~$80–120 (mostly quotes) | Predictive | ✅ | $0.015 per text | Light | No free trial |
| Kixie | ~$95–215, mostly quotes | Single and multi-line | ✅ | ✅ | ❌ | Add-ons ~$50 reputation, ~$50 AI, ~$20 DNC |
| Convoso | ~$90 (quote) | Predictive | ✅ | ✅ | ❌ | Built for large call centers |
| REsimpli | $199 (1 user, 1,000 min + SMS) / $499 (5 users) | 3-line | ✅ | ✅ | ✅ | Extra users $99 |
| Salesforce Sales Dialer | $25 outbound + $5 inbound + $15 per 1,000 min | Click-to-dial only | ❌ | ❌ | Needs Salesforce | Annual contract |
| Smarter Contact (texting only) | $199 / $399 / $499 (billed quarterly) | — | — | +$0.02–0.03 per text | — | Elite Plus $799–1,799 with bundled texts |

**Where Caller Whale wins:**

- Dialer, CRM, list cleaning (Features 1–2), SMS and call logs in one app. Most competitors are dialer-only; only REsimpli is all-in-one.
- Calls are blocked automatically by DNC, the never-call list, network hints and the lead's calling hours before every dial.
- "Call me first" for old PCs, Windows 7/8 and phones.
- Every call outcome makes the next list check smarter (Feature 2 network).
- Recording, voicemail drop and SMS included, where Mojo charges +$25 for recording, PhoneBurner has SMS only at $183, and Smarter Contact costs $199+ just for texting.
- Power dialing by default, with automatic 3% abandonment tracking on multi-line.

**Where they win today:** proven at scale (ReadyMode, Convoso); predictive dialing for 50+ agents; integrations with Salesforce and HubSpot; established number-reputation tools (ReadyMode iQ, Kixie ConnectionBoost).

> "Dialer, auto dialer, texting, call logs and your list cleaning in one app. No separate CRM, no separate skip tool, no separate texting tool."

Sources: [Telnyx voice pricing](https://telnyx.com/pricing/voice) · [Telnyx call control pricing](https://telnyx.com/pricing/call-control/uy) · [Telnyx 10DLC fees](https://support.telnyx.com/en/articles/5634625-10dlc-fees-and-charges) · [Telnyx 10DLC FAQ](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc) · [Telnyx 10DLC registration](https://telnyx.com/products/10dlc-registration) · [10DLC pricing breakdown](https://www.calilio.com/blogs/10dlc-pricing) · [Call abandonment rate](https://justcall.io/blog/call-abandonment-rate.html) · [Power vs progressive vs predictive dialers](https://aloware.com/blog/what-is-a-progressive-dialer) · [STIR/SHAKEN attestation](https://www.bandwidth.com/blog/abcs-of-attestation-and-analytics/) · [FCC 26-32](https://docs.fcc.gov/public/attachments/FCC-26-32A1.txt) · [ReadyMode pricing](https://www.capterra.com/p/136728/Readymode/pricing/) · [Mojo pricing](https://resimpli.com/blog/mojo-dialer-pricing/) · [BatchDialer pricing](https://resimpli.com/blog/batchdialer-pricing/) · [PhoneBurner pricing 2026](https://aloware.com/blog/phoneburner-pricing) · [CallTools pricing](https://www.itqlick.com/calltools/pricing) · [Kixie pricing 2026](https://aloware.com/blog/kixie-pricing) · [Convoso (Capterra)](https://www.capterra.com/p/76768/Cloud-Predictive-Dialer/reviews/Capterra___6339793/) · [Smarter Contact pricing](https://www.pitchprfct.com/blog/smarter-contact-alternatives/) · [Smarter Contact (Softwarefinder)](https://softwarefinder.com/sales-tools/smarter-contact) · [REsimpli pricing](https://www.resimpli.com/pricing) · [Salesforce Sales Dialer pricing](https://salesforce.com/products/sales-dialer-pricing)

## Amounts, cost and selling price

This prices **the feature**, not the plans. The tier names are labels only.

| | Free trial | Solo (1) | Duo (2) | Team (3+) | Pro (3+) |
| --- | --- | --- | --- | --- | --- |
| Dial pad, call logs, recording | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Dialing mode** | Power (1 line) | Power (1 line) | Power (1 line) | Power (1 line) | **Multi-line (2–3) + auto voicemail skip + voicemail drop** |
| **Minutes per month** | 30 | 3,000 | 6,000 shared | 3,000 per seat, shared | 8,000 per seat, shared |
| **Texts per month** | ❌ (needs registration) | 500 | 1,000 shared | 500 per seat, shared | 2,000 per seat, shared |
| **Numbers included** | 1 shared demo number | 1 | 2 | 1 per seat | 3 per seat |
| Number health / rotation | — | Health | Health | Health | Health + rotation |
| **Cost to Caller Whale, fully used** | ~$0.30 | ~$43 | ~$81 | ~$40 per seat | ~$135 per seat |
| **Cost to Caller Whale, typical use** (~50%) | ~$0.15 | ~$22 | ~$41 | ~$20 per seat | ~$70 per seat |
| **Selling price of this feature** | Free | **$99 / month** | **$179 / month** for both | **$89 per seat / month** | **$239 per seat / month** |
| **Margin, fully used** | — | ~57% | ~55% | ~55% | ~44% |
| **Margin, typical use** | — | ~78% | ~77% | ~78% | ~71% |

How the fully used cost adds up: Solo is 3,000 min × $0.011 = $33, a number ~$1.50, 500 texts $3.50 and texting registration ~$5. Pro is 8,000 min × $0.011 = $88, voicemail checks ~$26, 3 numbers ~$4.50, 2,000 texts $14 and registration ~$2.

**Why these selling prices:** Solo at $99 includes recording and 500 texts, against Mojo single-line at $99 (no texting, recording +$25) and PhoneBurner at $140–165 (texting only at $183). Pro at $239 includes multi-line, voicemail drop and texting, against ReadyMode at $199–249, which still needs a separate CRM, skip tracing and texting tool. Pro has the thinnest margin because auto dialing burns minutes, which is why it is capped at 8,000 minutes rather than "unlimited".

### Add-ons

| Add-on | Price | Cost to Caller Whale | Margin |
| --- | --- | --- | --- |
| +1,000 minutes | **$20** | ~$11 | ~45% |
| +1,000 texts | **$15** | ~$7 | ~53% |
| Extra phone number | **$3 / month** | ~$1–2 | ~50%+ |
| Texting registration (one-time) | **$25** | $19.50 | Covers carrier fees |
| Premium voicemail detection | **+$15 per seat / month** | ~$0.0045 extra per answered call | Depends on volume |

### Risks

1. Heavy auto dialers are the only users who can push Pro below ~40% margin. The minute cap protects Caller Whale.
2. ReadyMode and BatchDialer advertise unlimited calling. Caller Whale's answer is that its price includes the CRM, skip tracing and texting.
3. Texting registration takes days to weeks, so texting is not in the trial.
