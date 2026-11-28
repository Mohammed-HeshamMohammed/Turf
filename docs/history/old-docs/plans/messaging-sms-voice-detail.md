# Messaging, texting and calling: the detail

**Status:** Research and working detail for [messaging-sms-voice.md](messaging-sms-voice.md), which holds the decisions. Nothing here is built.
**Date:** 2026-11-14

Everything in this document that is a price, a limit or a legal rule was read from the web on 2026-11-14, mostly from vendor pages, law-firm summaries and forums. No account was opened and nothing was tried. Each section says what is still to confirm. **This is not legal advice; the texting and calling rules need a TCPA lawyer before launch.**

## 1. The five findings that change the plan

1. **Cold texting is the largest risk in the whole product, and it is not a technical one.** Carrier registration (10DLC) was built to keep unsolicited texts off ordinary numbers. Texting property owners from a skip-traced list, with no prior contact, is treated as a rejection risk at registration and as exposure under the TCPA. Registration makes texts deliverable; it does not make a cold text lawful. As the company that holds the carrier account, a few customers doing this can get **every** customer's texting suspended. Section 3 says how the product should be shaped around that.
2. **Voicemail, not conversation, is where calling money goes.** On a cold list roughly one dial in eight reaches a person. A much larger share is answered by voicemail, and every one of those is a billed call. Whether the carrier bills in whole minutes or six-second steps moves the monthly cost of one caller by about $20 to $55. This is the first question to put to Telnyx.
3. **Paid machine detection can cost more than the minutes.** At Telnyx's listed $0.0065 a call for the premium detector, a three-line dialer making 25,000 calls a month pays up to $162 for detection against $40 to $95 for the calls. This confirms the decision to build our own (stage D), and it means **single-line dialing should not use detection at all**: the caller hears the voicemail and moves on.
4. **"Unlimited calling" at $99 is thin on Telnyx and loses money on Twilio.** Worked through in section 6: about $55 to $73 of direct cost per single-line caller on Telnyx, $85 to $120 on Twilio. Competitors either charge more ($119 to $299 a seat) or cap minutes. The plan needs a fair-use line and the cheaper routes of stages C to E to be comfortable.
5. **A multi-line dialer has a legal speed limit.** A person who answers must be connected to a caller within two seconds, and no more than 3% of answered calls may be dropped, measured per campaign. The dialer's pacing has to be built around that number, not around how many lines the carrier allows.

## 2. Messaging (internal chats and groups)

### What is reused

**Centrifugo** (Go, Apache 2.0) holds the sockets. Its own tutorial builds a messenger this way and names the failure to avoid: if the service saves a message and then tells Centrifugo in a separate step, a crash between the two loses the live update. The proven fix is the **outbox**: the message and a "to deliver" row are written in one database transaction, and Centrifugo reads that table itself (PostgreSQL consumer). Centrifugo 6.8 adds a newer way to publish inside the same transaction, but its makers say the details may still change, so the outbox is the choice for now.

### Design rules, each from an established practice

| Rule | Why |
| --- | --- |
| Every message gets a number that only goes up within its conversation | The app can tell it missed something (a gap) and ask for exactly that range. Order never depends on clocks |
| The app makes the message's id before sending, and the service treats a repeat of that id as the same message | A retry after a lost connection never posts twice. Centrifugo's publish accepts the same key and ignores repeats for five minutes |
| Unread is one number per member per conversation: the last message number they have seen | No row per message per person. Unread count is a subtraction. This is how large chat products keep unread cheap |
| One private channel per person, not one per conversation | A person in 200 conversations holds one subscription. Who may receive what is decided when the service publishes, in one place |
| The live socket carries only "something changed, here it is"; the truth is always the database | A missed live message is repaired by asking for everything after the last number seen |
| Row-level security per workspace, as `crm-core` does | A bug in a query cannot show one workspace's chat to another |
| Attachments go to file storage with short-lived links, never through the socket | Size limits, virus scanning and access checks happen in one place |

### Tables (first version)

`conversations` (kind: direct, group, lead; workspace; title; last message number), `members` (conversation, person or external number, role, last number read, muted, archived), `messages` (conversation, number, sender, kind: text, note, system; how it travelled: internal or sms; body; reply-to; edited; deleted), `reactions`, `polls` and `poll_votes`, `attachments`, `outbox`.

### What the Inbox already expects, and where it comes from

Replies, six reactions, mentions, polls, archive, mark unread, group names and membership, search: all are columns or small tables above. Typing and "online" come from Centrifugo's presence and are never stored. Notifications when the app is closed go through the existing `notifications` service.

### Still to confirm

- That Centrifugo can check the tokens the `auth` service already signs (EdDSA) from its public keys. If not, `messaging` issues a short-lived Centrifugo token at connect time.
- Whether the web CRM's offline vault should keep chat history, and how much.
- Whether `crm-core`'s own live-updates socket should move to Centrifugo later. Not needed for this work.

## 3. Texting

### The rules that shape the product

| Rule | What it means for us | Confidence |
| --- | --- | --- |
| Every business texting from ordinary US numbers must register a **brand** and a **campaign** | Each customer workspace registers its own business, under our account. Texting is switched on per workspace only after approval | High |
| Registration needs a description of **how people agreed** to be texted, and sample messages that match | A workspace with no consent story will be rejected. A rejected campaign pays the fee again; some rejections are permanent | Medium (vendor guides) |
| Real estate is on vendors' lists of closely checked categories; cold outreach to bought or scraped lists is the usual reason for trouble | See "The cold-texting decision" below | Medium |
| T-Mobile limits texts **per brand per day** by a trust score; sole proprietors get one campaign, one number and a low daily limit (a figure of 1,000 a day is quoted) | The send queue enforces a daily limit per workspace and shows it. Solo customers without a registered company are limited by the carriers, not by us | Medium; the exact table is in Telnyx's rate-limit page |
| STOP must be honoured; marketing texts only between 8 a.m. and 9 p.m. in the **recipient's** time; several states are stricter | `sms` refuses a send outside the window worked out from the recipient's area code and address, and keeps its own opt-out list as well as the carrier's | High for the federal rule; state rules are in `campaigns-law-by-state.md` |
| The FCC's "revoke all" rule was delayed to 31 January 2027 and then replaced by a narrower final rule published 26 October 2026 | An opt-out by any reasonable wording ("stop", "leave me alone") must be caught, not only the word STOP. Confirm the final text with counsel | Medium; sources differ on the effective date |
| States have their own laws with their own damages (Florida, Oklahoma, Texas among at least 15) | Rules are data per state, not code, as the state workbook already assumes | Medium |

### The cold-texting decision

The customers are investors who skip trace owners and then contact them. Calling a cold list is lawful within the Do Not Call and dialer rules. Texting it is where the carriers and the law both push back. Three shapes the product could take:

| Shape | What customers can do | Risk to the platform |
| --- | --- | --- |
| **A. Conversations only (decided 2026-11-14)** | Text a lead who texted or called first, who gave their number on a form with consent, or who agreed on a call (the caller records the agreement, and the first text refers to the call) | Low. This is what a campaign description can honestly say |
| B. Consent-gated campaigns | As A, plus bulk sends to leads whose consent is recorded, with the source of consent kept per lead | Medium. Needs the consent record to be real and auditable |
| C. Open sending to any list | What the cold-texting tools sell, at $0.02 to $0.03 a text | High. Campaign rejections, carrier filtering, account suspension for everyone, and per-text damages claims against customers |

**Decided 2026-11-14: shape A, conversations only.** `sms` sends to a lead only when one of these is on record: the lead texted or called first, the lead gave the number on a form with consent, or a caller recorded the lead's agreement on a call. There is no bulk send. Shape B can be added later on the same consent record; shape C is not planned.

These protect the account as well: one brand per workspace so a suspension stays with its owner; a slow daily ramp for a new workspace; automatic pause when opt-outs or carrier error codes pass a threshold; no public link shorteners; the business name and opt-out wording in the first message of a thread.

### What `sms` does

- Takes `sms.send.requested`, checks consent, opt-out, quiet hours, the workspace's daily limit and its registration, then queues.
- Sends at the rate the carrier allows for that campaign; retries on carrier failure with the same id so nothing is sent twice.
- Counts **segments**, not messages: 160 plain characters is one segment, but one emoji or accented letter drops the limit to 70. The composer shows the count because every segment is charged, and the workspace's allowance is in segments.
- Receives carrier webhooks, checks their signature, stores the raw event, and publishes `sms.received` and `sms.status`.
- Keeps numbers, brands, campaigns, the opt-out list and a cost record per segment.

### Fees found (all passed through by the carrier)

| Item | Amount |
| --- | --- |
| Brand registration | about $4 to $4.50 once; optional vetting about $41.50 more, which can raise daily limits |
| Campaign review | $15 per submission, paid again after a rejection |
| Campaign, monthly | $1.50 to $10 depending on type; $2 for a sole proprietor |
| Carrier surcharge per text segment sent | AT&T $0.0035, T-Mobile $0.0045, Verizon $0.0045 to $0.0050; picture messages $0.007 to $0.010. All three rose during 2026 |
| Telnyx's own charge | about $0.004 per segment sent; received texts free (T-Mobile still charges its surcharge on received texts) |
| Approval time | brand 1 to 7 working days; campaign 3 working days to 4 weeks |

## 4. Calling

### The rules that shape the dialer

| Rule | What it means for us | Confidence |
| --- | --- | --- |
| An answered call is "abandoned" if no caller is connected within **2 seconds** of the greeting; at most **3%** of answered calls per campaign may be abandoned (measured over 30 days by the later rule) | Multi-line pacing is driven by the measured abandon rate and slows itself down as it nears 3%. The rate is shown to the workspace owner and kept as a record | High for the rule; confirm the measuring period in 16 CFR 310.4(b)(4) |
| The phone must ring at least 15 seconds or 4 rings before giving up | Minimum ring time is fixed in the dialer | High |
| When no caller is free, a recorded message with the business's name and number must play | Each workspace records one before multi-line dialing is allowed | High |
| The National Do Not Call Registry must be checked. Access costs $85 per area code a year (first five free; $23,425 for all), from October 2026 | The registry is licensed to the **seller**, so each customer needs its own account number. Our part is the scrub and the proof it ran. The state rules workbook covers state lists | High for fees; who must subscribe needs counsel |
| Recording needs everyone's consent in roughly 10 to 13 states (California, Florida, Illinois, Maryland, Massachusetts, Montana, Nevada, New Hampshire, Pennsylvania, Washington on every list; Connecticut, Delaware, Michigan, Oregon on some) | Recording is off unless the workspace turns it on. When either party is in one of those states, an announcement plays or recording is skipped | Medium; lists differ |
| Calling hours: 8 a.m. to 9 p.m. recipient's time federally; states vary | Same engine as texting hours | High |

### Getting calls answered: caller ID reputation

Calls marked "Spam Likely" are the dialer's commercial problem, and the fixes are known:

1. **Full attestation** (the carrier vouches that we may use the number). It needs numbers held at the carrier placing the call. This is a second reason failover between carriers needs care: a Telnyx number sent out through another carrier arrives with weaker attestation.
2. **Register every number** at the Free Caller Registry, which informs the three companies that label calls for the networks, and set the caller name.
3. **Spread calls over a pool of numbers** and limit calls per number per day. No source gave a reliable limit; start low (about 50 a day per number), measure answer rate per number, and adjust.
4. **Watch each number's answer rate.** A sudden fall is the sign it has been labelled. Rest it or retire it; sources agree that retiring is usually quicker than appealing.
5. **Local numbers must be real.** Showing a local number is fine when we hold it and it rings back to the business. Showing numbers we do not hold is spoofing.

A new factor in 2026: iPhones now screen unknown callers by asking who is calling. Telnyx's premium detector was extended in May 2026 to recognise that screen. Ours will have to as well.

### How a call is placed

- **Click to call and single-line power dialing:** the app calls out directly through the carrier's browser kit with a short-lived token from `voice`. The caller hears the ring and the answer. No machine detection.
- **Multi-line:** `voice` asks the carrier to place several calls with machine detection; the caller waits on an open line; the first call answered by a person is joined to the caller. The join must happen inside the two-second limit. **This pattern was not found as a ready example for Telnyx and must be prototyped and timed before it is promised.**
- Either way the carrier's events (ringing, answered, machine, ended, recording ready) arrive as signed webhooks; `voice` stores them raw, and publishes `call.completed` for `crm-core` to record against the lead.

### Machine detection

| Option | Cost | Notes |
| --- | --- | --- |
| None (single line) | $0 | The caller is the detector |
| Telnyx standard | $0.002 a call (an older Telnyx note says free; the price page says $0.002) | Result in about 4 seconds is typical for carrier detectors |
| Telnyx premium | $0.0065 a call | Recognises iPhone call screening |
| Twilio | about $0.0075 a call | Claims near 100% in the US in its slower mode |
| Our own (stage D) | Server time only | Published results for learned detectors: 94% to 96% accuracy; one vendor reports 0.3% of people wrongly taken for machines over 77,000 calls. Asterisk's built-in detector gives person, machine or not sure, with no published accuracy |

No detector is right every time, and tuning one error down pushes the other up. A person taken for a machine is a hung-up call that counts toward the 3% limit. So ours replaces the carrier's only after it has been run silently beside it on the same real calls and matched or beaten it.

### The desktop app's microphone

- Windows (WebView2): works with a permission handler; the library under Tauri has merged one, and the matching Tauri change was still open when read.
- macOS (WKWebView): a history of prompts not appearing, appearing twice, and audio problems on particular macOS versions; a refusal can only be undone in System Settings.
- **Test both in step 0.** If macOS is unreliable, the fallback is to open the dialer in the person's ordinary browser, which the web CRM already supports.

## 5. Carriers, routing and our own telephony

- **Telnyx first, one row in the route table.** Questions to put to Telnyx before building: billing increment for outbound calls; whether detection is charged on unanswered calls; calls-per-second and concurrent-call limits on a new account; how sub-accounts for many customer brands work; whether the browser kit and server call control can share one call.
- **Twilio second.** Its browser kit and its webhooks differ, so the carrier interface is proven only when both sit behind it. Texting on Twilio needs its own registration of the same brands, so it is prepared for workspaces that need cover, not for all.
- **Our own telephony (stage C).** The usual proven layout is a signalling router (Kamailio or OpenSIPS) in front for routing and failover, and media servers (FreeSWITCH or Asterisk) behind for audio. FreeSWITCH is the one more often chosen for browser calling and high call counts; Asterisk is simpler and its detector is built in. Capacity claims found (500 to 3,000 calls per processor core) had no method behind them: load-test our own. The main processing cost is converting between the browser's audio format and the phone network's.
- **Wholesale carriers (stage E).** BulkVS's only figures found were years old ($0.004 a minute for calls; a messaging line at $0.004). Get a current rate sheet. Check before relying on any wholesale route: attestation level given to our calls, whether dialer traffic (many short calls) is allowed or surcharged, and billing increment.
- **Cheapest-first routing** needs, per route: price, measured answer rate, measured failures, and whether it may carry dialer traffic. The cheapest route by price list is not the cheapest if fewer calls are answered through it, so routes are compared on **cost per conversation**, not cost per minute.

## 6. What one caller costs

### Assumptions (change these and the answer changes)

| Assumption | Value | Source |
| --- | --- | --- |
| Dialing time | 6 hours a day, 21 days: 126 hours a month | Ours |
| Dials per hour | 85 single-line; multi-line limited by the caller to about 25,000 dials a month | One vendor's figure; ours |
| Reaches a person | 13% of dials | One wholesaler's forum post (300,000 dials, 40,000 connects) |
| Answered by voicemail | 35% of dials | **Our guess; measure it** |
| Average conversation | 1.5 minutes | **Our guess; measure it** |
| Call price | $0.007 a minute on Telnyx (another source says $0.009); $0.014 on Twilio; $0.004 wholesale | Web, unconfirmed |
| Text price | $0.004 plus about $0.004 carrier surcharge on Telnyx; $0.0083 plus $0.004 on Twilio | Web |
| Numbers | $1.10 a month each with texting; 5 for single-line, 15 for multi-line | Telnyx page; ours |

### Single-line caller, 10,710 dials a month

| Cost | Telnyx | Twilio |
| --- | --- | --- |
| Conversations: 1,392 calls, 2,088 minutes | $15 | $29 |
| Voicemail pick-ups: 3,749 calls, billed 1,250 minutes (six-second steps) to 3,749 minutes (whole minutes) | $9 to $26 | $18 to $52 |
| Recording, if on | $4 | more |
| Numbers | $6 | $6 or more |
| 1,500 texts | $12 | $18 |
| Campaign fee | $10 | $10 |
| **Total** | **about $55 to $73** | **about $85 to $120** |
| Against the $99 price | $26 to $44 left before servers, payment fees and support | Nothing left |

### Multi-line caller, about 25,000 dials a month

| Cost | Telnyx, carrier detection | Own telephony, own detection, wholesale minutes |
| --- | --- | --- |
| Conversations: 3,250 calls, 4,875 minutes | $34 | $20 |
| Voicemail pick-ups: 8,750 calls, billed 875 to 8,750 minutes | $6 to $61 | $4 to $35 |
| Machine detection | $24 to $50 standard; $78 to $162 premium | servers only |
| Recording, numbers, texts, campaign | about $48 | about $48 |
| **Total** | **about $112 to $305** | **about $72 to $103, plus servers** |

### What the numbers say

1. Ask Telnyx the billing increment first. It is the widest range in both tables.
2. Hang up on voicemail fast. Every second after a machine answers is paid for.
3. Single-line never needs paid detection.
4. Multi-line on carrier detection only works at the Power price; stages C to E are what make it comfortable.
5. Texts are profitable as sold: 1,000 extra for $15 cost about $8.
6. Write a fair-use line for "unlimited" before launch (competitors cap or charge more: BatchDialer $119 to $189, Mojo from $139, ReadyMode $199 to $299, REsimpli 5,000 minutes or texts shared by five people for $499).

## 7. Reliability, security and testing

| Area | Practice |
| --- | --- |
| Webhooks | Check the carrier's signature, reject old timestamps, store the raw event first, process after. Every handler safe to run twice |
| Money | A cost row for every call and segment, with the route. A workspace has a daily spend limit that stops sends and dials, so a mistake or stolen account cannot run up a bill |
| Fraud | Calls and texts to non-US and premium destinations are off unless switched on; this is the classic way telephony accounts are drained |
| Privacy | Recordings and message bodies are personal data: encrypted at rest, kept for a stated period, visible by role, deletable with the lead |
| Health | Per route: calls answered, call length, time to first ring, text delivery rate, opt-out rate, carrier error codes. A route is rested after repeated failures and retried after a pause |
| Tests | A pretend carrier behind the same interface, so the whole flow runs in the existing GitHub checks without a real account. Carrier test credentials for one end-to-end check before each release. A load test of the multi-line join against the two-second limit |
| Audit | Proof kept for each send and dial: consent source, Do Not Call check, time window check, who pressed the button |

## 8. Order of work, with what ends each step

| Step | Work | Ends when |
| --- | --- | --- |
| 0 | Telnyx account; the questions in section 5; register Caller Whale's own brand and a test campaign; microphone and browser-call test in the desktop app on Windows and macOS; a lawyer's view on the cold-texting decision and on who holds the Do Not Call subscription | Answers written into this document; a test call and a test text work |
| 1 | `messaging` with Centrifugo: direct and group chats replacing the Inbox demo data | Two people chat live; a message sent twice appears once; messages missed offline arrive in order |
| 2 | `sms` on Telnyx, shape A: workspace registration flow, one-to-one texting, opt-out, hours, limits, cost record | A lead's reply lands in the thread; STOP and a plain-words opt-out both block sending; a send outside hours is refused with the reason |
| 3 | Team notes in customer threads | A note can be shown never to have been sent |
| 4 | `voice` on Telnyx: click to call, single-line power dialing, call log, recording with state rules, number pool and registration | The Calls page places real calls and `crm-core` records outcomes; each number's answer rate is visible |
| 5 | Multi-line dialing with carrier detection, pacing held under 3% | A week of real dialing with the abandon rate recorded under the limit |
| 6 | Twilio behind the same interfaces; failover for calls | Telnyx switched off in a test and calls still go out |
| 7 | Own telephony container | The same calls placed through our server with equal or better answer rate and audio |
| 8 | Own machine detection, run silently beside the carrier's, then switched on | It matches or beats the carrier's on the same calls |
| 9 | Wholesale carriers and cheapest-first routing by cost per conversation | A cheaper route carries traffic and falls back cleanly |

## 9. Risks

| Risk | How likely | How bad | What limits it |
| --- | --- | --- | --- |
| Customers cold-text and the carrier account is suspended | High if shape C | All texting stops for everyone | Shape A, one brand per workspace, ramp, automatic pause |
| A customer is sued over texts or calls sent through us | Medium | Reputation; possibly our own exposure | Checks that cannot be switched off, the audit record, clear terms, counsel |
| Unlimited calling costs more than it earns | Medium | Margin | Fair-use line, fast voicemail hang-up, stages C to E, spend limits |
| Numbers get labelled as spam | High over time | Fewer answers, unhappy customers | Registration, pool, per-number limits, answer-rate watch |
| Multi-line cannot join within two seconds | Unknown | Feature cannot ship as designed | Prototype in step 0 or 4 before it is sold |
| Desktop microphone unreliable on macOS | Medium | Calling from the desktop app | Open the dialer in the browser |
| Registration delays | High | A new customer cannot text for days or weeks | Start registration at sign-up; show its status; calling works meanwhile |
| Own telephony is more work than expected | High | Stages C to E slip | It is last; stages A and B stand without it |
| Carrier prices rise again (all three surcharges did in 2026) | High | Text margin | Cost record per segment; allowance set in segments; prices reviewable |

## 10. To confirm with primary sources or people

1. Telnyx: the questions in section 5, and current prices from its own pricing pages.
2. The Campaign Registry and CTIA rules on what a real estate investor's campaign may say and send.
3. A TCPA lawyer: the cold-texting shapes, who subscribes to the Do Not Call Registry, the abandon-rate measuring period, the final consent-revocation rule, recording announcements.
4. Our own numbers: voicemail share, conversation length, answer rate per list type. The first weeks of step 4 should record these so section 6 can be redone with real figures.
5. BulkVS: a current rate sheet and its terms for dialer traffic.

## Sources

**Texting and registration**
- [Telnyx: 10DLC rate limits](https://developers.telnyx.com/docs/messaging/10dlc/10dlc-rate-limits), [Telnyx: sole proprietor guide](https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration), [Telnyx: campaign registration best practices](https://support.telnyx.com/en/articles/6325731-10dlc-campaign-registration-best-practices), [Telnyx: appeal rejected campaigns](https://telnyx.com/release-notes/appeal-rejected-10dlc-campaigns-api-portal.md)
- [Skipcall: 10DLC and cold texting](https://skipcall.io/en/blog/a2p-10dlc-cold-texting), [BiggerPockets: SMS campaign thread](https://www.biggerpockets.com/posts/7266423), [REsimpli: 10DLC requirements](https://resimpli.com/10dlc/), [Twilio error 30959](https://www.twilio.com/docs/api/errors/30959)
- [Bandwidth: AT&T surcharge changes, April 2026](https://www.bandwidth.com/support/en/articles/13566708-changes-to-at-t-surcharge-rates-on-april-1-2026), [Twilio: T-Mobile fee changes, January 2026](https://support.twilio.com/hc/en-us/articles/44609260499995-T-Mobile-Messaging-Carrier-Fee-Changes-January-2026), [Sinch: US charges and surcharges](https://support.app.sinch.com/hc/en-us/articles/11744630072335-USA-Canada-Charges-surcharges), [Voice Elements: regulatory fees](https://www.voiceelements.com/docs/programmable-sms/messaging-regulatory-fees/), [CallSphere: 10DLC walkthrough 2026](https://callsphere.ai/blog/vw5d-a2p-10dlc-registration-walkthrough-2026)
- [b2bsalestools: Smarter Contact vs Launch Control](https://b2bsalestools-com.pages.dev/compare/smarter-contact-vs-launch-control/)

**Law**
- [Burr: revoke-all rule delayed to 31 January 2027](https://www.burr.com/telephone-consumer-protection-act/the-fcc-delays-effective-date-of-tcpa-revoke-all-rule-until-january-31-2027), [Troutman: FCC revises revocation rules](https://www.troutman.com/insights/fcc-revises-tcpa-revocation-of-consent-rules-that-were-set-to-go-into-effect-in-january/), [Nixon Peabody: quiet hours decision](https://www.nixonpeabody.com/insights/alerts/2026/05/13/a-loud-decision-on-tcpa-quiet-hours), [JD Supra: TCPA and state laws](https://www.jdsupra.com/legalnews/telephone-consumer-protection-act-tcpa-6652966/), [Byte Back: state updates](https://www.bytebacklaw.com/2026/07/looking-back-on-the-last-year-of-state-level-tcpa-updates/)
- [FTC: abandoned-call safe harbour (Federal Register)](https://www.govinfo.gov/content/pkg/FR-2004-11-17/pdf/04-25470.pdf), [Olshan: call abandonment amendments](https://www.olshanlaw.com/Advertising-Law-Blog/FTC-Telemarketing-Sales-Call-Abandonment), [FTC: 2027 Do Not Call Registry fees](https://www.ftc.gov/news-events/news/press-releases/2026/08/ftc-announces-2027-telemarketer-fees-access-national-do-not-call-registry)
- [Layer3 Labs: two-party consent states](https://www.layer3labs.io/guides/two-party-consent-states), [Ringio: two-party consent states](https://help.ringio.com/en/articles/6314449-two-party-consent-states-call-recording)

**Calling**
- [Telnyx: Voice API pricing](https://telnyx.com/pricing/voice-api), [Telnyx: numbers pricing](https://telnyx.com/pricing/numbers), [Telnyx: answering machine detection](https://developers.telnyx.com/docs/voice/programmable-voice/answering-machine-detection), [Telnyx: premium detection and iPhone call screening](https://telnyx.com/release-notes/premium-amd-ios-call-screening.md), [Superdupr: Telnyx pricing 2026](https://superdupr.com/blog/telnyx-pricing)
- [Twilio: detection best practices](https://www.twilio.com/docs/voice/answering-machine-detection-faq-best-practices.md), [Cekura: voicemail detection testing](https://www.cekura.ai/blogs/voicemail-detection-testing-for-voice-ai), [Dograh: open source detection](https://dograh.com/feeds/blog/answering-machine-detection-open-source)
- [SignalWire: resolving spam labels](https://signalwire.com/docs/platform/voice/resolving-spam-labels), [Aloware: why a number is marked spam](https://aloware.com/blog/why-is-my-number-marked-as-spam), [Aloware: iOS 26 call screening](https://aloware.com/blog/how-to-get-past-ios-26-call-screening), [FirstDigital: calls marked as spam](https://learn.firstdigital.com/bin/view/FirstDigital%20Product%20Support/Calls%20Marked%20as%20Spam%3F/)
- [BiggerPockets: 300,000 cold calls a month](https://www.biggerpockets.com/posts/7270478), [BatchDialer: predictive dialer](https://batchdialer.com/?p=253528), [Prospeo: BatchDialer pricing](https://prospeo.io/s/batchdialer-pricing-reviews-pros-and-cons), [Kixie: ReadyMode cost](https://www.kixie.com/?p=15596), [REsimpli: BatchDialer pricing](https://resimpli.com/blog/batchdialer-pricing/)
- [Wry: permission handler](https://github-redirect.dependabot.com/tauri-apps/wry/issues/1195), [Apple forums: WKWebView microphone prompt](https://developer.apple.com/forums/thread/734363)

**Architecture**
- [Centrifugo tutorial](https://centrifugal.dev/docs/tutorial/intro), [Centrifugo: outbox and CDC](https://centrifugal.dev/docs/tutorial/outbox_cdc), [Centrifugo: what the tutorial teaches](https://centrifugal.dev/docs/tutorial/outro), [Centrifugo: PostgreSQL stream broker](https://centrifugal.dev/blog/2026/05/24/pg-stream-broker-benefits)
- [Pistack: Kamailio, Asterisk and FreeSWITCH 2026](https://www.pistack.xyz/posts/2026-04-18-kamailio-vs-asterisk-vs-freeswitch-self-hosted-voip-pbx-guide-2026/), [Pistack: transcoding with FreeSWITCH and rtpengine](https://www.pistack.xyz/posts/2026-06-03-self-hosted-voip-media-codec-transcoding-freeswitch-rtpengine-guide/)
- [Nerd Vittles: BulkVS](https://nerdvittles.com/another-bargain-sip-provider-for-incredible-pbx-platforms/), [BulkVS](https://www.bulkvs.com/), [Bandwidth pricing](https://www.bandwidth.com/pricing/)
