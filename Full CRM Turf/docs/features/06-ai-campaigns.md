# Feature 6: AI email and messaging campaigns

**Status:** Agreed (2026-10-25)

The customer picks leads from their lists, Caller Whale's AI writes a message for each lead, sends it in steps over time, reads the replies and updates the CRM. **Everything runs on Caller Whale's server**, so the device doesn't matter: any computer or phone can build, approve and follow a campaign.

## How it works

1. **Pick who:** a list, a filter, or leads at a stage ("absentee owners in Tampa, not yet contacted, with a good email").
2. **Pick the channel and the steps:** for example email on day 1, a reminder on day 4, a last email on day 10. **A lead's steps stop as soon as they reply.**
3. **The AI writes each message** from the lead's own details: name, property address, owner type (person, LLC, estate…), absentee or not. The customer sets the tone and the offer and sees samples before anything sends.
4. **Approve mode or auto mode:**
   - **Approve (default):** the AI drafts and a person approves, one at a time or in bulk.
   - **Auto:** it sends within the limits the customer set.
5. **The AI reads every reply** and sorts it: interested, not interested, question, stop, wrong person, already sold.
   - Interested → the stage moves, a callback task is created, and the right person is notified.
   - A question → the AI drafts an answer for a person to approve.
   - Stop → the lead is blocked for good on that channel.
   - Wrong person → feeds Feature 2's evidence and right-person check.

## Channels and their rules

| Channel | Who it can go to | Rules Caller Whale enforces |
| --- | --- | --- |
| **Email** | **Cold email is allowed** under the federal email law (CAN-SPAM), which is about identification and opt-out, not consent | Honest subject line, the sender's physical address in every email, a working unsubscribe honoured at once, no fake headers |
| **SMS** | **Only people who agreed or engaged first:** replied, opted in, or came in as an inbound lead. Marketing texts need prior written consent, and the Do Not Call registry covers texts. | A registered texting campaign (Feature 3), STOP honoured at once, consent recorded on the lead |
| **Direct mail** (optional, paid per postcard) | **Anyone**: postcards and letters need no consent | The lead's address, sent through a print-and-mail service (Lob) |

**Cold SMS stays out on purpose**: it is where real-estate investors get sued.

## Getting email into inboxes

Gmail and Yahoo require anyone sending more than 5,000 emails a day to have **SPF, DKIM and DMARC** on the sending domain, **one-click unsubscribe**, and a **spam-complaint rate under 0.3%** (ideally under 0.1%). Caller Whale handles this:

| How | Why |
| --- | --- |
| **Each customer sends from their own domain** (e.g. `mail.oakpalm.com`), never from Caller Whale's | One bad customer can't harm every other customer's delivery |
| **A setup wizard** walks the customer through the DNS records and checks them | Most customers won't know what DKIM is |
| **Warm-up:** a new domain starts with a few dozen emails a day and grows over weeks | Sudden volume from a new domain goes straight to spam |
| **Small sequences can go from the customer's own Gmail / Outlook** (connected in Feature 5) | Best delivery for 1-to-1 follow-ups; low daily limits |
| **Auto-pause** when bounces or complaints climb | Protects the domain before it gets blocked |
| **Feature 2's email verdicts** (typos, throwaway, shared inboxes) clean the list before sending | Fewer bounces, better reputation |

## AI safety rules

- The AI uses only facts **from the lead's record**: no made-up prices, offers or claims.
- Every message is checked before sending for banned wording, an honest subject line and the required footer.
- **Never** messages anyone opted out, on DNC (for SMS), on the never-contact list, or outside the hours of their time zone.
- Stop and wrong-person replies are applied automatically. Everything else that changes a deal waits for a person.

## Where it runs

| Device | What the person does |
| --- | --- |
| Desktop, web, old PC (Firefox 115 ESR) | Build campaigns, see samples, approve drafts, read results |
| Phone | Approve AI reply drafts, see who is interested, get notified |
| **Server** | **Everything else:** writing, scheduling, sending, reading replies, updating the CRM |

## Where the data lives

| Data | Where |
| --- | --- |
| Campaigns, steps, templates, tone settings | Server, per workspace |
| Every send and its result (delivered, bounced, opened, clicked, replied) | Server; shown in the lead's activity |
| AI drafts and the reply sorting | Server; kept so a person can see why the AI decided |
| **Unsubscribes and opt-outs** | Server, per workspace (legally each sender's own list) |
| **Hard bounces** (the address doesn't exist) | Server, **shared across Caller Whale** like Feature 2's network: an address that bounced for one customer is flagged for all |
| Sending domain records and warm-up state | Server, per workspace |

## What it costs Caller Whale

**AI (Claude list prices per million tokens):** Haiku 5.5 is $0.10 in / $0.50 out; Sonnet 5.5 is $2 in / $10 out.

| Job | Model | Cost each |
| --- | --- | --- |
| Write one personalized email or text (~1,500 tokens in, ~250 out) | Haiku 5.5 | **~$0.0003** (half through the batch API, which suits scheduled campaigns) |
| Sort one reply | Haiku 5.5 | **~$0.0001** |
| Draft an answer to a reply | Sonnet 5.5 | **~$0.005** |

**Sending:**

| Item | Cost |
| --- | --- |
| Email through Amazon SES | ~$0.10–0.16 per 1,000 |
| **One campaign email, all-in** (AI + sending) | **~$0.0005**, so ~$0.50 per 1,000 emails |
| One campaign text | ~$0.007 (Feature 3) + ~$0.0003 AI |
| Sending domain | The customer's own, ~$10–15 a year, paid by them |
| Dedicated sending IP (big senders only) | ~$25 / month at SES |
| Postcard (optional) | ~$0.58–0.87 each, printing and postage included |

AI is cheap enough that sending costs more than writing, and both are tiny.

## Competition

| Tool | What it is | Price |
| --- | --- | --- |
| Smartlead | Cold-email sender with AI | $39 / month base; $94 for API; realistically $200–600 / month with mailboxes and domains |
| Instantly | Cold-email sender | $47 / month; bundles with lead data $94 / $194 / $555 |
| lemlist | Cold email + multichannel | $69–109 / month; extra senders $9 each |
| Carrot CRM (formerly InvestorFuse) | Real-estate CRM with follow-up sequences | $69 (3 users, 8 sequences) / $179 (5 users, 15) / $349 (10 users, unlimited); AI features pay-per-use |
| REsimpli | Real-estate CRM with drip email/SMS and "9 AI agents" | Basic $149 / Pro $299 / Enterprise $599 (yearly) |
| HubSpot Marketing Hub | General marketing | Starter $15–20 / seat (1,000 contacts, no automation); automation needs Professional at ~$890 / month |
| Smarter Contact | Real-estate texting | $199–499 / month + $0.02–0.03 per text |

**Where Caller Whale wins:** the AI writes from the lead's own property data and Skip Tracing results, not a generic template; replies update the CRM by themselves (stage, callback task, the right person notified), where cold-email tools stop at the inbox; wrong-person replies feed Feature 2's right-person check and bounces feed the Caller Whale network; compliance is built in (no cold SMS, opt-outs across channels, DNC and quiet hours, auto-pause before a domain is burned); list cleaning (Feature 2) runs before sending.

**Where they win:** sending at big scale (Smartlead and Instantly juggle dozens of mailboxes and warm-up networks); huge lead databases (Instantly), which for Caller Whale would come from the supplier (Feature 1b); marketing websites and landing pages (Carrot, HubSpot).

Sources: [Claude model pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) · [Lob pricing](https://lob.com/pricing) · [Lob pricing details](https://help.lob.com/print-and-mail/ready-to-get-started/pricing-details) · [Google and Yahoo sender requirements (PowerDMARC)](https://powerdmarc.com/google-and-yahoo-updated-email-authentication-requirements-for-2024/) · [Bulk sender requirements (Close)](https://help.close.com/technical-support/email-deliverability/requirements-for-bulk-email-senders) · [TCPA in 2026 (Vida)](https://vida.io/blog/tcpa-2026-what-changed) · [TCPA 2026 changes (Kixie)](https://www.kixie.com/sales-blog/tcpa-2026-changes/) · [Marketing laws overview (CAN-SPAM, TCPA)](https://open-exam-prep.com/study-guides/cipp-us/education-telecom-marketing/marketing-statutes) · [Instantly vs Smartlead vs Lemlist 2026 (SmartReach)](https://smartreach.io/blog/instantly-vs-smartlead-vs-lemlist/) · [Instantly vs Smartlead vs Lemlist (Valley)](https://www.joinvalley.co/blog/instantly-vs-smartlead-vs-lemlist) · [Smartlead pricing (Landbase)](https://www.landbase.com/blog/smartlead-pricing) · [Carrot CRM pricing](https://carrot.com/crm-pricing/) · [CarrotCRM plans](https://carrot.com/investorfuse-pricing/) · [REsimpli (SaaSworthy)](https://www.saasworthy.com/product/resimpli) · [HubSpot pricing 2026 (Automation Atlas)](https://automationatlas.io/answers/hubspot-pricing-explained-2026/) · [Smarter Contact pricing](https://www.pitchprfct.com/blog/smarter-contact-alternatives/)

## Amounts, cost and selling price

This prices **the feature**, not the plans. The tier names are labels only. Texts sent by campaigns come out of Feature 3's text allowance, so they are not counted twice.

| | Free trial | Solo (1) | Duo (2) | Team (3+) | Pro (3+) |
| --- | --- | --- | --- | --- | --- |
| AI writing, reply sorting, CRM updates | ✅ | ✅ | ✅ | ✅ | ✅ |
| Approve mode / auto mode | Approve only | Both | Both | Both | Both |
| **Campaign emails per month** | 100 | 5,000 | 10,000 shared | 5,000 per seat, shared | 20,000 per seat, shared |
| **AI reply drafts per month** | 20 | 500 | 1,000 shared | 500 per seat, shared | 2,000 per seat, shared |
| **Active campaigns at once** | 1 | 3 | 5 | 10 | Unlimited |
| Send from own Gmail / Outlook | ✅ | ✅ | ✅ | ✅ | ✅ |
| Own sending domain + warm-up | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Cost to Caller Whale, fully used** | ~$0.15 | ~$5 | ~$10 | ~$5 per seat | ~$20 per seat |
| **Selling price of this feature** | Free | **$49 / month** | **$79 / month** for both | **$39 per seat / month** | **$79 per seat / month** |
| **Margin, fully used** | — | ~90% | ~87% | ~87% | ~75% |

### Add-ons

| Add-on | Price | Cost to Caller Whale | Margin |
| --- | --- | --- | --- |
| +5,000 campaign emails | **$10** | ~$2.50 | ~75% |
| +1,000 AI reply drafts | **$10** | ~$5 | ~50% |
| Dedicated sending IP (big senders) | **$49 / month** | ~$25 | ~49% |
| Postcards (optional) | **~$1.09 each** | ~$0.58–0.87 | ~20–47% |

**Why these selling prices:** Solo at $49 sits between Smartlead ($39) and lemlist ($69) and updates the CRM, which they don't. Carrot's sequences start at $69 for 3 users, and REsimpli bundles campaigns into its $149–599 plans. Pro at $79 per seat includes 20,000 emails and 2,000 AI reply drafts per seat, where HubSpot charges ~$890 a month just to unlock automation.
