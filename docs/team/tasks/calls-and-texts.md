# Calls and texts

`dialer-sms`, the six `telnyx-*` containers, `centrifugo`. Plan: [messaging, texting and calling](../../plans/messaging-sms-voice.md).
Nothing calls or texts a real lead until the dialer leaves simulate mode and 10DLC is approved.

| ID | Task | Needs | Source | Taken by | Status |
| --- | --- | --- | --- | --- | --- |
| TEL-01 | Learn the Telnyx setup as it runs today: simulate mode, the six containers, webhooks, budgets | — | [Coolify setup: dialer](../../operations/coolify-setup-dialer.md) | | open |
| TEL-02 | Open the real Telnyx account in the company's name and start 10DLC brand registration | BIZ-02 | Messaging plan step 0 | | open |
| TEL-03 | Decide who registers with the carriers: each customer's business under our account, and what we collect at sign-up | Rana's research | Messaging plan, decision 3 | | open |
| TEL-04 | 10DLC campaign per agency, with the lawyer's wording | TEL-02, LAW-10 | Step 39 | | open |
| TEL-05 | Move the dialer from simulate mode to real calls, one test agency first | TEL-02, SEC-03 | Messaging plan step 4 | | open |
| TEL-06 | Split traffic from `dialer-sms` onto the six `telnyx-*` containers | TEL-05 | [Service registry](../../../contracts/services.md) | | open |
| TEL-07 | Each lead's own time zone for calling hours and scheduled texts | — | Steps 10, 21 | | open |
| TEL-08 | Number checks and number health | — | Step 21, D213-D216 | | open |
| TEL-09 | Captions on incoming calls; the agent's own words in captions; Spanish | — | Step 26, D285 | | open |
| TEL-10 | Tune complaint and opt-out rate limits with real traffic | TEL-05 | Step 39 | | open |
| TEL-11 | Budgets for bulk texts | — | Steps 10, 22 | | open |
| TEL-12 | Opt-out and consent rules for texts | LAW-09 | Steps 10, 25, D207-D209, D351, D353, D354 | | open |
| TEL-13 | The AI reading replies and captions for opt-outs (today: word rules) | TEL-12 | Steps 25, 26, D352 | | open |
| TEL-14 | Test the microphone and browser calling inside the desktop app's window | — | Messaging plan step 0 | | open |
