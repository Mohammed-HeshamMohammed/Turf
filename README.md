# Dialer, auto dialing and SMS

Feature 3: calling and texting leads through **Telnyx** (Voice API / Call Control, SIP for browser calling, Messaging API), the carrier's webhooks, and logging every finished call in the CRM. With `TELNYX_MODE=simulate` (the default) it talks to a **built-in Telnyx simulator** instead, so the CRM's calling and texting rules can be tried end to end before any minute is bought.

| | |
| --- | --- |
| Part | Feature service (server) |
| Language | Go |
| Default port | 8113 |
| Owns data | Yes, its own PostgreSQL schema (`dialer_sms`) |
| Status | Built and tested against the simulator (2026-11-15). Not deployed: it needs its own Coolify application (ask the owner first). Never run against real Telnyx yet |

Plan: `docs/plans/messaging-sms-voice.md`. Feature: `docs/features/03-dialer-auto-dialing-sms.md`.

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

**Texting** is conversations only: a lead can be texted after they texted the workspace, or once consent is recorded (`POST /api/v1/sms/consent`, source `form` or `call`). STOP (and STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) blocks texts until START. Delivery reports move a text forward (queued, sent, delivered or failed), never back.

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
cd services/features/dialer-sms && go test ./...                 # without a database the scenario tests are skipped
DIALER_TEST_DATABASE_URL=postgres://postgres@localhost:5432/dialer_test?sslmode=disable go test ./...
```

The scenario tests play every call scenario four ways (as sent, every webhook twice, reordered, both) and check the CRM gets one call with the right outcome; and inbound calls, texts, STOP/START, consent, the webhook signature and the calling token. crm-core's `TestTheDialerLogsCarrierCallsAsThePersonWhoMadeThem` checks what each outcome does to the lead.

## Not built yet

- The CRM screens: the Calls page still uses its own demo; it should call `POST /api/v1/calls`, show the wrap-up buttons, and load the Telnyx WebRTC kit with `POST /api/v1/calls/token` so the caller hears the lead. Until then the simulator is driven from the command line above.
- Bridging the caller's browser audio into an auto-dialled call when a person answers, and the multi-line auto-dial queue and pacing (3% abandonment).
- Calling hours in the lead's time zone and state rules before each dial; the plan's monthly minutes (billing) before each dial; number health and rotation.
- Texts are kept here, not yet in the messaging service's lead conversations (the Inbox); the messaging plan wants them there.
- Twilio as the second carrier (the `carrier` interface is where it goes) and the route table.
