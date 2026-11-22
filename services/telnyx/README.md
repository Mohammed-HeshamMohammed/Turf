# Telnyx calls and texts (was dialer-sms)

**Being split (2026-11-22, D389):** this folder (package `telnyx`) becomes six containers, named for what they do and the carrier they use: `telnyx-phone-api` (8113), `telnyx-phone-webhooks` (8122), `telnyx-phone-jobs` (8123) for calls and `telnyx-sms-api` (8124), `telnyx-sms-webhooks` (8125), `telnyx-sms-jobs` (8126) for texts. Until the new Coolify apps run, `cmd/dialer-sms` runs every part in one program, as deployed (image `cw-dialer-sms`, network name `dialer-sms`, which is also its caller name in authz's and billing's token lists).

Feature 3: calling and texting leads through **Telnyx** (Voice API / Call Control, SIP for browser calling, Messaging API), the carrier's webhooks, and logging every finished call in the CRM. With `TELNYX_MODE=simulate` (the default) it talks to a **built-in Telnyx simulator** instead, so the CRM's calling and texting rules can be tried end to end before any minute is bought.

| | |
| --- | --- |
| Part | Feature service (server) |
| Language | Go |
| Default port | 8113 |
| Owns data | Yes, its own PostgreSQL schema (`dialer_sms`) |
| Status | Built and tested against the simulator (2026-11-15). Not deployed: it needs its own Coolify application (ask the owner first). Never run against real Telnyx yet |

Plan: `docs/plans/messaging-sms-voice.md`. Feature: `docs/pricing-and-market/features/03-dialer-auto-dialing-sms.md`.

## The six containers

`roles.go` decides what each runs; `cmd/<name>` starts it; each has its own image (`cw-<name>`), Dockerfile (`Dockerfile.<part>`),
port, settings (`env/<name>.production.example`, the same on all six except `PORT`) and health (`/healthz`, `/version`, `/status`).

| Container | Port | Answers | Timed work |
| --- | --- | --- | --- |
| `telnyx-phone-api` | 8113 | `/api/v1/calls`, `numbers`, `budgets`, `recording`, `voicemail-drops`, `status`, `leads/{id}/signals`; `/telnyx-sim` in simulate mode | none |
| `telnyx-phone-webhooks` | 8122 | `/webhooks/telnyx` (Telnyx sends `call.*` here) | none |
| `telnyx-phone-jobs` | 8123 | health only | settling calls (2 s), callbacks and old captions (1 min), erasures (10 min) |
| `telnyx-sms-api` | 8124 | `/api/v1/sms...`; `/telnyx-sim` in simulate mode | none |
| `telnyx-sms-webhooks` | 8125 | `/webhooks/telnyx` (the messaging profile sends `message.*` and `10dlc.*` here) | none |
| `telnyx-sms-jobs` | 8126 | health only | scheduled texts (30 s), unanswered texts (1 min), 10DLC and standing (10 min) |

- **Why calls and texts apart:** Telnyx sends a call's webhooks to the call's webhook URL and texts' to the messaging profile's, and
  wants each answered within about two seconds. A texting burst, a bulk send or a slow CRM never delays a call's reaction (answer,
  machine hang-up, the voicemail at the beep).
- **Two copies of anything are safe:** settling and scheduled texts lock their rows (`SKIP LOCKED`); every other timed pass takes an
  advisory lock for its length (`onlyOne`), so one copy does it and the other skips the round. Webhooks are stored once by event id.
- **A webhook at the wrong address is not lost:** either webhooks container takes any Telnyx event with the same checks and code.
- **Live mode addresses:** `TELNYX_WEBHOOK_URL` (sent with each call) is `telnyx-phone-webhooks`' public address; the messaging
  profile's webhook in the Telnyx portal is `telnyx-sms-webhooks`' public address. Both reach them through the gateway (one host each).
- **Simulate mode:** `telnyx-phone-api` and `telnyx-sms-api` each host their side's simulator and send its webhooks to their
  webhooks container (`SIM_WEBHOOK_URL` overrides). The others call that simulator (`TELNYX_API_URL` overrides) and check its
  signatures. So all six need the same `TELNYX_SIM_PRIVATE_KEY` and `TELNYX_API_KEY`.
- **The switch:** the deployed app (`cmd/dialer-sms`, alias `dialer-sms`) keeps working until the six apps are healthy; then it is
  stopped and `telnyx-phone-api` also takes the alias `dialer-sms`. Nothing else calls this service by name today (it has no domain
  yet). Its caller name in authz's and billing's token lists stays `dialer-sms`.

## How it works

```
CRM (browser) --POST /api/v1/calls--> dialer-sms --POST /v2/calls--> Telnyx (or the simulator)
                                          ^                              |
                                          +---- signed webhooks ---------+
                                          |
                                          +--> crm-core /internal/v1/dialer/calls  (call.record, as the person who called)
```

1. **Dial.** The dialer asks crm-core whether the person may call the lead (role, assignment, do-not-call) and dials **the CRM's number for the lead**, never one a browser sent. It asks Telnyx for answering machine detection (`TELNYX_AMD`) and puts its own call id in `client_state`.
2. **Webhooks.** Each is checked (Ed25519 signature over `timestamp|body`, at most 5 minutes old) and stored once by its event id: a repeat changes nothing. Facts keep their first or strongest value, so the order they come in does not matter.
3. **Acting on them.** Answered: start recording if asked. Machine: hang up, or wait for the beep and play the voicemail drop, then hang up. Inbound call to a workspace number: answer, and ring the number's owner in the browser when they have a calling login. Transfer: Telnyx moves the lead to the closer.
4. **Settling.** A few seconds after the hangup (`SETTLE_SECONDS`, for late webhooks) the outcome is decided from all the facts (`outcome.go`). A call a person answered waits for the caller's wrap-up (`POST /api/v1/calls/{id}/disposition`) for up to `WRAPUP_SECONDS`, then counts as Reached (or Dead call if it dropped).
5. **Logging.** The call goes to crm-core as the same `call.record` operation a device sends, with the call id as the operation id, so it is logged once however often it is sent. crm-core does the rest exactly as for a call logged by hand: stage, verdict, do-not-call, callback task, appointment task on a transfer, the audit trail, live updates, and the Team page's numbers. The carrier's facts (durations, billed minutes, hangup cause, SIP code, machine detection, recording) are kept in the call's `details`.

| What the carrier says | CRM outcome |
| --- | --- |
| A person answered | What the caller chose (Reached, Not interested, Callback, Do not call, ...); Reached after the wrap-up time |
| A person answered, then the call dropped | What the caller chose, or Dead call |
| Answering machine (with or without a voicemail drop) | Voicemail |
| Rang out / no answer / caller hung up first | No answer |
| Busy (486), rejected (603) | Not available |
| Not in service (404, 410, 484, 604) | Disconnected |
| Carrier failure (5xx) | Dead call |
| Transferred and the closer answered | Transfer |
| Inbound call answered | Reached, on the lead with that number (not logged when no lead has it) |

**Texting** needs consent for the agency, the lead's client and the number (build step 25): the lead texted first, consent was recorded (`POST /api/v1/sms/consent {lead_id, source: form|call, call_id}`), or the agency confirmed it for the lead's list in the CRM. After 6 months without contact it is confirmed again on a call. A reply that is only an opt-out blocks at once: "stop texting me" texts, "stop calling me" calls, "STOP" or "leave me alone" both; texts here, and the agency's block list in the CRM for calls (START lifts what a reply made). A reply that mentions "stop" in a sentence is marked `opt_out_question: waiting`, and nothing is sent until the thread's sender answers `POST /api/v1/sms/{id}/opt-out {opt_out}`. A number the CRM blocks for texts is never texted. The carrier sends the STOP confirmation on registered numbers. Delivery reports move a text forward (queued, sent, delivered or failed), never back.

**Lead threads (build step 10).** A lead's texts are one thread with one sender: the lead's agent, unless someone above took it over (the owner or an admin, a lead of the lead's team, its deputy, by rank). `GET /api/v1/sms/threads/{lead}` is the texts, internal notes and control (who sends, who may take over, hand back or ask back); `POST /api/v1/sms/threads/{lead}/takeover`, `/handback`, `/ask-back`, `/notes {body}`. A text from the lead not answered within the agency's wait (`PUT /api/v1/sms/settings {wait_minutes}`, 15 by default) tells the team's leads and deputies (the owner when the team has none); one waiting on whoever took it over goes back to the agent and both are told. What people were told: `GET /api/v1/sms/alerts`, `POST /api/v1/sms/alerts/{id}/seen`. The CRM says who works the lead and the asker's rank in its `/internal/v1/dialer/lead` answer. Working hours (`PUT /api/v1/sms/hours {team_id, time_zone, days}`, the agency's or a team's) stop the wait outside them. Templates: `POST /api/v1/sms/templates {name, body, team_id}` (owner, admins, team leads), `GET /api/v1/sms/templates?lead_id=` filled in with `{first_name}`, `{last_name}`, `{name}`. `POST /api/v1/sms` with `send_at` schedules a text (sent 8:00-21:00 in the agency's time zone, cancelled if the number is blocked meanwhile). `POST /api/v1/sms/bulk {lead_ids, text}` (owner, admins, team leads) schedules one text per lead now, and lists those that cannot be texted.

**Team numbers, hours and status (build step 21).** `PUT /api/v1/numbers/{number}` takes `team_id` (a team's number) or `default: true` (the agency's, for teams without one). A lead is called and texted from the number it already knows, else its team's, else the default. Calls and texts go out only between 8:00 and 21:00 in the agency's time zone (its working hours' zone), or the shorter hours set with `PUT /api/v1/sms/settings {contact_from, contact_until}`; `SIM_ANY_HOURS=true` lifts this in simulate mode only. `PUT /api/v1/status {status}` (available, break, off) and `GET /api/v1/status`; on a call is worked out from the calls. An incoming call rings the lead's agent, then the team's other available agents, then its leads and deputies, each only when available with a calling login; else the call is recorded as a voicemail.

**Live calls, recording and voicemail messages (build step 21, part B).** `POST /api/v1/calls/{id}/join {mode: listen|whisper|takeover}` (a lead or deputy of the call's team, an admin or the owner, from their calling login) dials them in with the carrier's supervisor role (monitor, whisper, barge); `GET /api/v1/calls/{id}/joins` shows the agent who joined and the recording's pauses. `PUT /api/v1/recording {team_id, on}` (owner, admins) records every call of the agency or a team, after a spoken notice; `POST /api/v1/calls/{id}/recording {pause}` pauses and resumes it. `POST /api/v1/voicemail-drops {name, audio_url, team_id}` and `GET ?lead_id=`; a call takes `voicemail_drop_id`. A callback due while its agent is not available tells the team's leads and deputies once, after the agency's wait (`/api/v1/sms/alerts`, kind `callback`).

**Budgets (build step 22).** With `BILLING_URL` and `BILLING_TOKEN`, a call or a text is checked against the budgets of the lead's team and the person (and the plan's minutes) before it goes, and charged after it (a call's talk time, rounded up to the minute, once). `PUT /api/v1/budgets {scope: team|person|client, subject_id, kind: minutes|texts, monthly}`: the owner and admins, or a team's lead for their people. `GET /api/v1/budgets` (owner, admins, leads); `POST /api/v1/budgets/raise {scope, subject_id, kind, note}` when one is used up.

## Trying it with the simulator

The simulator plays these scenarios. Pick one per call with `"scenario"` in `POST /api/v1/calls` (simulate mode only), or call a number ending in its digits:

| Scenario | Digits | Expected outcome |
| --- | --- | --- |
| human_answered | 0001 | Reached (45 s talk, recorded) |
| voicemail | 0002 | Voicemail (the dialer hangs up on the machine) |
| voicemail_drop | 0012 | Voicemail (message played after the beep) |
| no_answer | 0003 | No answer |
| busy | 0004 | Not available |
| disconnected | 0005 | Disconnected |
| carrier_failure | 0006 | Dead call |
| rejected | 0007 | Not available |
| caller_hangup | 0008 | No answer (the caller hangs up first) |
| dropped | 0009 | Dead call |
| transfer | 0010 | Transfer |
| callback | 0011 | Callback (with its task) |
| do_not_call | 0013 | Do not call (the lead can no longer be called) |
| inbound_call, sms_inbound_reply, sms_delivered, sms_failed, sms_stop | | Reached; received; delivered; failed; refused |

**Run them all** against a running dialer, as a person of the workspace (the token is the CRM's sign-in token from the browser):

```bash
go run . scenarios -dialer http://localhost:8113 -token "$TOKEN" -org <workspace id> -lead <lead id> -phone "<the lead's number>" -sim-key "$TELNYX_API_KEY"
go run . scenarios -list
```

It prints PASS or FAIL per scenario; then open the lead in the CRM to see the calls, its stage and flags, and the Team page for the numbers. `do_not_call` runs last because it blocks the lead. Set `SIM_SPEED=10` on the dialer to make the run ten times faster. Before the inbound and text scenarios, give the workspace a number: `PUT /api/v1/numbers/+15125550100 {"user_id": "<who takes it>"}`.

The simulator's own controls (Bearer `TELNYX_API_KEY`), under `/telnyx-sim`: `POST /sim/inbound-call {"from","to"}`, `POST /sim/inbound-sms {"from","to","text"}`, `POST /sim/settings {"dupes": true, "reorder": true}` (send every webhook twice; reverse webhooks that happen together and hold `call.initiated` back), `GET /sim/log` (the last 500 webhooks it sent), `GET /sim/scenarios`.

It can also run on its own: `go run . sim` (`SIM_PORT`, `SIM_WEBHOOK_URL`, `TELNYX_API_KEY`); it prints the public key to give the dialer as `TELNYX_PUBLIC_KEY`, with `TELNYX_API_URL=http://<host>:8119/v2`.

## Switching from simulate to live Telnyx

1. In the Telnyx portal: buy a number; make a **Call Control application** (its id is `TELNYX_CONNECTION_ID`) with its webhook URL set to `https://<the dialer's public host>/webhooks/telnyx`; make a **messaging profile** with the same webhook URL (`TELNYX_MESSAGING_PROFILE_ID`) and register it for 10DLC (takes days to weeks); for browser calling, a **credential SIP connection** (`TELNYX_SIP_CONNECTION_ID`). Copy the **API key** and the **public key** (Keys & Credentials).
2. Give the dialer a public address for `/webhooks/telnyx` only (a gateway route, like `voice.callerwhale.com=http://dialer-sms:8113`, with Cloudflare challenges off for it).
3. Set `TELNYX_MODE=live`, `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_PUBLIC_KEY`, `TELNYX_MESSAGING_PROFILE_ID`, and redeploy. The service refuses to start in live mode without the first three. Nothing else changes: the same code path ran against the simulator.
4. Assign the number to the workspace (`PUT /api/v1/numbers/{number}`) and make one real call to a phone of your own before anyone else uses it.

## Coolify

One application, Dockerfile build pack, base directory = this folder, port 8113, health `/healthz`, no domain (the gateway routes the webhook host). Its own PostgreSQL database. Variables: `env/dialer-sms.production.example`. Also needed:

- crm-core: `DIALER_TOKEN` (the same value as the dialer's `CRM_TOKEN`), then redeploy crm-core.
- authz: `,dialer-sms=<token>` appended to `AUTHZ_TOKENS` (the dialer's `AUTHZ_TOKEN`).

Simulate mode costs nothing but the container (it runs inside it, no extra service).

## Run and test

```bash
cd services/dialer-sms && go test ./...                 # without a database the scenario tests are skipped
DIALER_TEST_DATABASE_URL=postgres://postgres@localhost:5432/dialer_test?sslmode=disable go test ./...
```

The scenario tests play every call scenario four ways (as sent, every webhook twice, reordered, both) and check the CRM gets one call with the right outcome; and inbound calls, texts, STOP/START, consent, the webhook signature and the calling token. crm-core's `TestTheDialerLogsCarrierCallsAsThePersonWhoMadeThem` checks what each outcome does to the lead.

**Captions and call signals (build step 26, part B).** An answered outgoing call is captioned when the CRM says the agency requires captions or the AI's suggestions are on for the caller (Telnyx `transcription_start`, the lead's side, English); captions pause with the recording. Each finished line is kept and read for practical signals: a callback asked for (with its time filled in, inside calling hours), agreeing to meet, an opt-out for this agency or for anyone, asked about price, wants to sell soon, mentioned another buyer. The wrap-up's outcome is pre-selected from them (opt-out, then callback, then meeting as Transfer). `GET /api/v1/calls/{id}/captions` (the call's agent, the team's leads and deputies, admins, the owner) is the lines, the signals and `suggested_outcome`; `POST /api/v1/calls/{id}/signals/{signal} {confirm}` (the call's agent) confirms or dismisses one: a confirmed opt-out marks the call "Do not call" (for anyone when the lead said so, sent to the CRM as `dnc_kind`), a confirmed callback fills in its time. The wrap-up takes `dnc_kind` too. `GET /api/v1/leads/{id}/signals` is what earlier calls with the lead brought up. `PUT /api/v1/calls/keep {days}` (owner, admins) removes captions and recording addresses older than that. The reading is word rules, the same for every agency, learning from nobody's calls. In the simulator, scenarios `human_answered`, `callback` and `do_not_call` say a line, and `POST /sim/say {call_control_id, text}` makes the lead say anything.

**Call summary (build step 26, part C).** With `ASSISTANT_URL` and `ASSISTANT_TOKEN`, `POST /api/v1/calls/{id}/summary` (the call's agent, on a call with the AI's suggestions on) asks the assistant to summarise the call from its captions and signals, charged as one `ai` use to the lead's team and client. It answers `summary`, `ai_outcome` and `suggested_outcome` (an opt-out heard on the call stays first). The summary stays on the call (`ai_summary`) until the agent puts it in the wrap-up's notes.

## Not built yet

- The CRM screens: the Calls page still uses its own demo; it should call `POST /api/v1/calls`, show the wrap-up buttons, and load the Telnyx WebRTC kit with `POST /api/v1/calls/token` so the caller hears the lead. Until then the simulator is driven from the command line above.
- Bridging the caller's browser audio into an auto-dialled call when a person answers, and the multi-line auto-dial queue and pacing (3% abandonment).
- Calling hours in the lead's time zone and state rules before each dial; the plan's monthly minutes (billing) before each dial; number health and rotation.
- Texts are kept here, not yet in the messaging service's lead conversations (the Inbox); the messaging plan wants them there.
- Twilio as the second carrier (the `carrier` interface is where it goes) and the route table.

## Carrier registration and texting standing (build step 39)

Each agency registers its own texting brand and campaign with the US carriers (10DLC) through Telnyx (D268). With `CARRIER_CHECK` on (the default), nobody in the agency calls until the brand is verified, or texts until the campaign is provisioned (D314).
- `PUT /api/v1/carrier {business, campaign}` (owner or admin): entity type, legal name, display name, EIN (or a sole proprietor's name), email, phone, address, website; the campaign's description, message flow, two samples and links (real-estate defaults are filled in; *the wording is for the lawyer*). `POST /api/v1/carrier/submit` (owner) registers the brand; the campaign (use case MIXED, or SOLE_PROPRIETOR) is created when the brand is verified, and the agency's texting numbers are put on it when it is provisioned. `GET /api/v1/carrier` shows the state: not_submitted, brand_pending, brand_failed, campaign_pending, campaign_failed, approved. A refusal can be corrected and sent again.
- Telnyx's `10dlc.*` webhooks (to `TELNYX_WEBHOOK_URL`) make the dialer read the registration again; every 10 minutes it also checks what is still on its way.
- Texting standing (D269): opt-outs (replies taken as opt-outs) and complaints (replies with words like spam, scam, harass, lawyer, FCC, and texts the carriers blocked as spam) over 30 days, judged from 100 texts. Warned at 3% opt-outs or 0.1% complaints, limited at 5% or 0.3% (no bulk texts, 100 texts a day), suspended at 8% or 0.5%, one step a day at most. A warning or limit ends after 7 days under the warning line; a suspension only when staff clear it in the CRM. Every change is kept (`texting_steps`); the owner appeals once per step (`POST /api/v1/carrier/appeal {note}`). Starting lines, to tune with real traffic.
- The dialer reports each agency's state to the CRM (`/internal/v1/dialer/carrier`); the CRM's answer carries staff's review.
- Telnyx's fees (read 2026-11-18, check before going live): brand $4 once, vetting $40 once if asked for, campaign $10 a month (three months upfront), $0.03 per number put on a campaign. Brand checks take 1 to 7 business days; campaigns can take longer.
