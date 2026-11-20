# Campaigns: the law, state by state (research for Feature 6)

**Status:** research, 2026-11-11. **This is not legal advice and it is not a complete 50-state audit.** It was gathered from law-firm alerts and compliance-vendor guides (no statute was read in full), and those sources disagree in places; the disagreements are listed rather than settled. Every row marked *verify* must be checked against the statute or the state regulator before any rule below is built as law. The lawyer questions are at the end and are also meant for `docs/legal/lawyer-brief.md`.

**Superseded in part (same day):** the all-state table, the charges, and corrected quiet-hours and state-gate rules are in [`campaigns-law-all-states.md`](campaigns-law-all-states.md). Rule 4 below (9 am to 7 pm, Monday to Saturday) is wrong for Rhode Island and Kentucky: use the per-state table there, with Monday to Friday 10 am to 5 pm as the fallback.

It updates `docs/features/06-ai-campaigns.md` (the campaign spec) and follows the same rule as the learning store: law first.

## 1. The short answer for the case

Caller Whale's customers are real-estate investors who want to reach property owners. Three channels, three very different risks:

| Channel | Verdict | Why |
| --- | --- | --- |
| **Email** | Allowed, with rules | Federal CAN-SPAM needs identification, a postal address and a working opt-out, not consent. States add anti-deception suits (subject lines). |
| **SMS to people who agreed or engaged** | Allowed, with rules | Needs recorded consent, quiet hours, a working STOP, scrubbing, and in several states registration. |
| **Cold SMS (no consent)** | **Do not build as a default.** | Federal and many state laws make it the most litigated thing a platform like this can enable ($500 to $1,500 per text, class actions, state registration and bonds, carriers blocking it). If it is ever offered it must be off, gated per workspace and per lead, behind a lawyer's sign-off. |
| Direct mail | Allowed | No consent law for postcards and letters (spec, unchanged). |

## 2. Federal layer

| Rule | What it means for campaigns | Status / note |
| --- | --- | --- |
| **TCPA, marketing texts and calls** | Prior express written consent for marketing texts to cell phones sent with automated technology; damages $500 per message, up to $1,500 if willful; no proof of harm needed; class actions. | In force. The autodialer definition was narrowed by *Facebook v. Duguid* (2021) but plaintiffs plead around it and states widened it. |
| **Federal Do Not Call registry** | Numbers on it cannot be called or texted for marketing without consent or an established relationship. | **Open split on texts:** the 7th Circuit (*Steidinger*, July 2026: Illinois, Indiana, Wisconsin) and some district courts hold a text is not a "call" for the DNC private suit; the 9th Circuit (*Howard v. RNC*) and others disagree. Do not rely on the split: scrub for texts too. |
| **Quiet hours** | Federal: 8 am to 9 pm in the recipient's local time. | In force. States are stricter (section 3). |
| **Revocation of consent** | A person can stop messages by any reasonable means; sender must honour within a reasonable time, **no more than 10 business days**. In Sept 2026 the FCC narrowed "revoke all" (a reply to an informational message revokes only that category; marketing revocations are not narrowed), and let a sender name one reply keyword as the exclusive method as long as the seven standard words still work: stop, quit, end, revoke, opt out, cancel, unsubscribe. **Effective 25 Nov 2026**; a further proposal (7 business days) is open. | Adopted, effective soon. Build to the stricter version: honour all seven words at once. |
| **One-to-one consent** | The FCC rule requiring consent to name one seller at a time was vacated by the 11th Circuit in January 2025 (from memory, *verify*). | Do not rely on shared consent from lead sellers; record consent for Caller Whale's customer by name anyway. |
| **CAN-SPAM (email)** | Honest header and subject, sender's postal address, clear opt-out honoured within 10 business days, no harvesting. Preempts most state email laws except those on falsity or deception. | In force. |
| **Carriers (10DLC / CTIA)** | A texting campaign must be registered; cold outreach is rejected or filtered; consent must be provable. | Contract rule, not law, but it decides whether texts arrive. |

## 3. State layer: texting and telemarketing

A growing number of states have their own laws ("mini-TCPAs"). They matter because they widen what counts as automated, set stricter hours, add registration and bonds, and carry their own damages. Sources: Lead Friendly (vendor, "last verified Oct 8, 2026") and Mac Murray & Shuster (law firm), read in full; other vendor guides for cross-checks. "Verify" = pages disagree, or one source only.

| State | Law | Texts? | Hours (local time) | Private suit / money | Registration, bond | Notes / verify |
| --- | --- | --- | --- | --- | --- | --- |
| **Florida** | Telephone Solicitation Act (FTSA), §501.059; 2023 amendment | Yes | 8 am to 8 pm (other guides; one source silent: *verify*) | $500 per violation, $1,500 if willful; text claims need a STOP reply and a 15-day cure first | **Licence from FDACS, $1,500 fee, $50,000 bond** | Own state DNC list. Subject-line email class actions also growing in Florida. |
| **Oklahoma** | Telephone Solicitation Act (15 O.S. §775C), 2022 | Yes | 8 am to 8 pm | $500, $1,500 if willful | Not stated | Follows the Florida model. Real-estate wholesaling disclosure rules also exist (section 6). |
| **Maryland** | Stop the Spam Calls Act, Com. Law §14-4501 | Yes | 8 am to 8 pm | $500 per violation (pages disagree on "or actual damages") | Not stated | *Verify* damages and the daily cap one source mentions. |
| **Connecticut** | Gen. Stat. §42-288a, 2023 | Yes | 9 am to 8 pm | Unfair-practice suit, needs actual loss; penalties up to $20,000 per violation (one source) | Not stated | Written consent except existing customers. |
| **Virginia** | Telephone Privacy Protection Act; SB 1339 effective 1 Jan 2026 | Yes | 8 am to 9 pm unless consent | $500, then $1,000, then $5,000 each | Not stated | STOP and UNSUBSCRIBE honoured for **10 years**; seller and solicitor both liable. |
| **Texas** | Bus. & Com. Code ch. 302, 304, 305; **SB 140 effective 1 Sep 2025** | Yes (since 9/1/2025) | 9 am to 9 pm Mon to Sat (one source) | Deceptive-trade-practices suit, up to $5,000 per violation | **Registration with the Secretary of State per calling location: $200 fee, $10,000 security.** Per the SOS, text-only senders with consent may not need to register for now (federal case *Ecommerce Marketers Alliance v. Texas*): *verify* | Own state no-call list. Heavy litigation (hundreds of TCPA suits in 2025). |
| **Pennsylvania** | 73 P.S. §2241; **Act 47 of 2026 (SB 992), signed 20 Jul 2026, effective 18 Oct 2026** | Yes | **9 am to 7 pm, no Sundays** | Enforced as unfair trade practice (no private suit stated) | **Registration with the AG, $50,000 surety bond** | Opt-out keywords (STOP, QUIT, END and others) must work. Effective date: *verify*. |
| **Oregon** | ORS 646.561, HB 3865 effective 1 Jan 2026 | Yes | 8 am to 8 pm | $200 or actual damages; needs loss | **DOJ registration, $400 a year** | Max 3 contacts in 24 hours (the two sources disagree about an existing-relationship exception: *verify*). |
| **Washington** | RCW 80.36.390 / 19.158 and the commercial email and text law (CEMA, RCW 19.190); HB 1497 | Yes (consent in advance for commercial texts) | 8 am to 8 pm | Texts: **$100 per message** for suits filed since 11 Jun 2026 (was $500; ESHB 2274, one source) | Commercial telephone solicitor registration with the Department of Licensing | *Verify* the damages change and the statute numbers. |
| **New Jersey** | SB 921, effective Dec 2023 | Not stated | 8 am to 9 pm | Not stated | Annual registration, fee by calling capacity | *Verify* whether its no-call list is the federal one. |
| **Missouri** | RSMo 407.1095 to 407.1107 | Yes (SMS and MMS) | Not stated | Up to $5,000 per knowing violation (after more than one call in 12 months) | None | AG-run no-call list; business contact in the last 180 days is exempt. |
| **Indiana** | IC 24-5-12 | Not stated | Not stated | Not stated | Telephone solicitors register, $50 | Own no-call list, updated quarterly. |
| **Arizona** | HB 2498, 2023 | Extends no-call to texts | Not stated | Not stated | Not stated | |
| **California** | AB 2068 and AB 2905, effective 2025 | Not stated | Not stated | Not stated | Call-centre registration and reporting; artificial voice added to dialer definition | Strong consumer-protection and email deception suits (section 4). |
| **Georgia** | SB 73, effective Jul 2024 | Not stated | Not stated | Class-action right for no-call violations | Not stated | |
| **Utah** | HB 217 (dates inconsistent), SB 193 and SB 38 (2026) | Not stated | 8 am to 9 pm with consent | Not stated | Not stated | SB 38: seller must disclose name, phone, email and address orally or the buyer can cancel. Covers property-sale calls: *verify closely*. |
| **Tennessee** | SB 868 (2023), HB 2504 (2024), HB 2408 (2026) | SB 868 extends solicitation rules to texts | Not stated | Not stated | Volume caps and logs to AGs (HB 2408: *verify* enactment) | |
| **New York** | AB 8319, AB 7939, AB 4456 | Not stated | Not stated | Higher fines | Not stated | Disclosure at the start of certain calls. |
| **Maine, Mississippi, North Carolina, Wisconsin** | LD 396 / LD 2234, HB 1225, SB 445 (effective Dec 2026, *verify*), SB 531 | Not stated | Not stated | Not stated | Maine: registration | Mostly caller-ID, definitions and enforcement moves. Mississippi dropped its own list in 2023 and uses the federal one. |

**States with their own do-not-call list** (sources differ on the number, eleven or twelve): Colorado, Florida, Indiana, Louisiana, Massachusetts, Missouri, Oklahoma, Pennsylvania, Tennessee, Texas and a few others. Rule: scrub against the federal list **and** the state list of every state a lead is in.

**States not listed here** have no mini-TCPA that the sources found. That does not mean no rule: the federal rules, the state unfair-practice law and the state AG still apply. A lawyer's 50-state table should replace this one.

## 4. State layer: email

- CAN-SPAM preempts most state email regulation but **not state laws against falsity or deception**. That is where the suits are.
- **California** B&P §17529.5 (misleading subject lines and headers; private suits), **Maryland** MCEMA (about ten similar suits in one window, second highest risk), **Washington** CEMA (subject-line suits) and **Florida** (subject-line class actions, 2026) are the active ones. Utah and Virginia are said to have private rights for misleading commercial email. More than 30 states have email marketing laws.
- Practical rule: the subject line must tell the truth about the content. The AI's subject-line check is a legal control, not a style choice.

## 5. What this means for the build

These are the rules the campaign service must enforce. They are stricter than any one state so a customer is safe anywhere.

1. **A consent ledger per lead and channel.** Every text needs a recorded consent: who, when, how, the exact wording shown, the customer's name, the source. Without a record the lead cannot be texted. Keep records at least 5 years.
2. **Cold SMS is off.** No setting, no workspace toggle in the first release. If a lawyer ever approves it, it becomes a separate gated feature (state registration confirmed, consent evidence, per-state blocklist).
3. **State gate.** Before a campaign text is queued, check the lead's state: if the state needs registration or a bond (FL, TX, PA, OR, WA, NJ, IN and others as the lawyer confirms) the workspace must have entered its registration number for that state; otherwise that lead is held and the customer is told why.
4. **Quiet hours by the lead's local time, with the strictest window as the default:** 9 am to 7 pm local, Monday to Saturday, no Sundays or federal holidays (this is inside every state's window above, including Pennsylvania's). State-specific wider windows are allowed only from a table that is kept current.
5. **Frequency cap:** at most 3 contacts in 24 hours per lead across channels (Maryland and Oregon), and a lower campaign default.
6. **STOP handling:** honour stop, quit, end, revoke, opt out, cancel and unsubscribe, any case, at once (the law allows up to 10 business days; do not use them). A stop applies to all of the customer's campaigns on that channel and is kept at least 10 years (Virginia). The footer or first message of every text names the sender and says how to stop.
7. **Scrubbing:** federal Do Not Call, the state lists above, and a reassigned-number check, before each send and again on a schedule (a lead's number can be reassigned).
8. **Email:** postal address in every email, one-click unsubscribe, honest subject line checked before sending, from the customer's own domain (spec, unchanged).
9. **Records of what was sent** (message text, time, result) kept with the consent record, so a complaint can be answered.
10. **The customer carries their own compliance, and the product says so in the terms** (the Terms and Calling Policy pages already say the customer must have the right to contact people). The product's job is to make the legal path the easy one and the illegal path unavailable.
11. **AI writing:** use only facts from the lead's record; never write a message that claims consent, urgency or an offer the record does not support. Texts the AI drafts are approved by a person until the lawyer says otherwise.

## 6. Real-estate-specific rules (outside the messages, but the messages can break them)

Wholesaling and "we buy houses" marketing is regulated in more and more states. The campaign message is advertising, so these apply to what it says. Sources were vendor blogs and disagreed: *verify every row*.

- **Pennsylvania:** Act 52 of 2024 (effective Jan 2025) treats a wholesale transaction as broker activity: licence, written disclosure of profit, and a seller cancellation right (about 30 days).
- **Illinois:** wholesaling beyond one assignment in 12 months needs a licence (sources differ on the form of the 2023 law).
- **Virginia:** repeat contract assignment (two or more in 12 months) is treated as licensed activity.
- **Oklahoma, Maryland, Ohio, Texas, others:** disclosure rules for wholesalers to sellers and cooling-off periods, as described by vendor blogs.
- **Design consequence:** the customer states, per workspace, whether they are licensed and where; the message footer can include the required "I am not a licensed broker / I intend to assign this contract" style statement where the customer's state needs it. Do not generate wholesaling language that implies the sender owns the property or will certainly buy it.

## 7. Open points the sources did not settle

- Whether Texas registration applies to a text-only consent program (the SOS says not for now; a case is pending).
- The exact current damages and hours in Maryland, Oregon and Washington.
- Whether Pennsylvania's registration and bond apply to a software platform, to its customers, or to both.
- Platform liability: when does supplying the numbers, the sending tool and the AI-written text make Caller Whale a "seller or solicitor" with its customers (Virginia says both are liable; the TCPA has vicarious-liability cases).
- Any state not in the table.

## 8. Questions for the lawyer (add to `docs/legal/lawyer-brief.md`)

1. Confirm the consent standard we must record for marketing texts (federal and each state in section 3) and the wording a customer's opt-in form needs.
2. Which states require Caller Whale (the platform), the customer, or both to register or hold a bond for a texting-only consent program?
3. Is it ever acceptable to let a customer send a first text to a skip-traced number? If yes, under what proof and in which states?
4. Our liability as the platform when a customer sends illegal texts, and how the Terms, indemnity and "customer is the sender" clauses should read.
5. The correct state-by-state quiet-hours table, the daily cap, and the 10-year opt-out retention.
6. Wholesaling disclosures that a campaign message must carry, by state.
7. Whether AI-drafted messages change anything (disclosure, record-keeping).
8. A complete 50-state table to replace section 3.

## Sources

Lead Friendly, [Mini-TCPA laws by state](https://www.leadfriendly.com/guides/mini-tcpa-laws-by-state) · Mac Murray & Shuster, [State telemarketing legislative activity](https://mslawgroup.com/u-s-telemarketing-laws/) · [FCC TCPA revocation rules take effect Nov 25, 2026](https://commlawgroup.com/2026/fccs-new-tcpa-consent-revocation-rules-on-category-specific-opt-outs/) · [Nelson Mullins on the FCC revocation overhaul](https://www.nelsonmullins.com/insights/alerts/fcc-download/all/fcc-adopts-overhaul-of-tcpa-consent-revocation-rules-revoke-all-narrowed-exclusive-opt-out-methods-permitted-and-fraud-alert-exemption-expanded) · [Mintz, do text messages still trigger the TCPA (Sept 2026)](https://www.mintz.com/insights-center/viewpoints/2776/2026-09-28-do-text-messages-still-trigger-tcpa-national-and) · [Seventh Circuit, texts and the DNC private right](https://www.bakerlaw.com/insights/tcpa-update-seventh-circuit-rejects-private-right-of-action-for-text-messages-under-§-227c5/) · [Parker Poe, the TCPA tightrope](https://www.parkerpoe.com/news/2025/10/the-tcpa-tightrope-why-2025-is-a-turning) · [Morgan Lewis, state anti-spam laws](https://www.morganlewis.com/pubs/2026/01/emerging-digital-marketing-risks-the-revival-of-state-anti-spam-laws-and-implications-for-retailers) · [Ballard Spahr, subject-line class actions in Florida](https://www.ballardspahr.com/insights/alerts-and-articles/2026/04/trouble-in-paradise-subject-line-class-actions-come-to-florida) · [Compliance Point, Beyond CAN-SPAM](https://www.compliancepoint.com/marketing-compliance/beyond-can-spam-understanding-preemption-and-the-scope-of-state-email-laws/) · [Wholesaling laws by state (Crowdfunded Wealth)](https://www.crowdfundedwealth.com/articles/real-estate-wholesaling-laws-by-state-2026) · [ResiMpli, wholesaling laws](https://resimpli.com/blog/wholesaling-laws-and-regulations/) · [State do-not-call lists (Wipfli)](https://www.wipfli.com/insights/articles/state-do-not-call-lists-what-businesses-need-to-know)
