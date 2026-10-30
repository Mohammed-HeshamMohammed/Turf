# Second step at sign-in: four ways

**Status:** planned and being built (2026-10-30). Owner of the decision: the platform owner.

## What is wanted

After the password, a person proves it is them with any one of four things:

1. **A code by email** (to the address on the account).
2. **A code by Telegram** (optional: nobody has to link it, and the service works without a bot).
3. **An authenticator app** (a code that changes every 30 seconds). Up to **3 devices** per person: adding a 4th removes the oldest one.
4. **An approval in the app**: the sign-in attempt shows up on a device that is already signed in, and the person taps *Approve* there.

Staff (the platform owner and system administrators) must pass one every time; the core API and gateway already refuse staff paths without it. For everyone else it is required once they have turned on at least one way, and email is available to everybody as soon as their address is confirmed.

## Decisions (change one of these and tell me)

- **The auth service owns the second step, not Firebase.** Firebase has no email, Telegram or approval factor, and its authenticator needs the paid Identity Platform upgrade. So the second step lives in the auth service's own tables, works the same with or without Firebase for the password, and the `mfa` claim in the token means "the auth service saw a second step pass". The Firebase authenticator calls built earlier are removed.
- **"Each 3 activations removes the older devices"** is read as: at most **3 authenticator devices** at once; setting up a 4th removes the one set up longest ago. Removing one by hand is allowed after a second step.
- **"Notification to the app"** is an in-app approval (a prompt in the CRM, the desktop app or the website on a device already signed in), not an operating-system push. A real phone push needs Firebase Cloud Messaging and a mobile app, which do not exist yet.
- **Telegram** works through a bot the owner creates with BotFather. A person links it by opening a one-time link in Telegram. The bot only ever sends a code. No bot token, no Telegram option.
- Recovery codes stay for the plain (non-Firebase) mode only.

## How a sign-in goes

1. Email and password are right (Firebase checks them, or this service does).
2. If the person must or may use a second step, the answer is `401 mfa_required` with a one-time **challenge** (valid 10 minutes, 5 tries) and the list of **methods** they have: `totp`, `email`, `telegram`, `push`.
3. The client asks for the method: `email` and `telegram` send a six-digit code; `push` creates an approval request; `totp` needs nothing sent.
4. The person answers with the code, or approves on the other device. The service issues the tokens, with `mfa: true`.

A Google sign-in goes through the same step after it, on the session it opened (what `/v1/mfa/verify` did before).

## Data

| Table | Holds |
| --- | --- |
| `mfa_factors` | one row per way a person set up: kind (`totp`, `telegram`), label, the authenticator secret or the Telegram chat id, when made, when last used. Email has no row: it is the account address. |
| `mfa_challenges` | one row per second-step attempt: who, hash of the challenge secret, for a sign-in or for an open session, the code's hash and when it expires, tries used, approval state, when it ended. |
| `telegram_links` | a one-time link code (hash) waiting for the person to open it in Telegram. |

Secrets are never stored in the clear where a hash will do: challenge secrets and email/Telegram codes are hashed; authenticator secrets must be readable to check a code, so they are kept as the service's other secrets are (database only, never sent back after setup).

## Endpoints (all under `/v1/mfa`)

| Route | Needs | Does |
| --- | --- | --- |
| `GET /factors` | signed in | what the person has set up, and whether email is available |
| `POST /totp/setup`, `POST /totp/confirm` | signed in | add an authenticator (the old `/setup` and `/confirm` stay as the same routes); a 4th removes the oldest |
| `DELETE /factors/{id}` | signed in, second step passed | remove one |
| `POST /telegram/link` | signed in, second step passed | a one-time Telegram link; `POST /telegram/webhook/{secret}` is where Telegram reports the person opened it |
| `POST /challenge/send` | a challenge | send the email or Telegram code, or open the approval request |
| `POST /challenge/answer` | a challenge | check the code (or the approval) and open the session |
| `GET /challenge/{id}` | the challenge secret | where an approval request stands, for the waiting device |
| `GET /approvals`, `POST /approvals/{id}` | signed in, second step passed | the requests waiting for this person, and *Approve* / *Deny* |
| `POST /verify` | open session | the step-up after Google, same methods |

## Limits that matter

- 5 wrong answers end a challenge; 5 failed sign-ins per address still pause the address for 15 minutes.
- A code is good for 10 minutes and works once. A new code replaces the old one. At most one email or Telegram code every 30 seconds.
- An approval request is shown with the time, the kind of device and the place it came from, and lasts 5 minutes. A device that is not itself signed in with a second step passed cannot approve.
- Telegram and email carry only the code and a line saying who asked. Nothing else.

## Settings (auth service)

`AUTH_SMTP_HOST`, `AUTH_SMTP_PORT`, `AUTH_SMTP_USER`, `AUTH_SMTP_PASSWORD`, `AUTH_MAIL_FROM` (email codes); `AUTH_TELEGRAM_BOT_TOKEN`, `AUTH_TELEGRAM_BOT_NAME`, `AUTH_TELEGRAM_WEBHOOK_SECRET` (Telegram; the bot's webhook is set once to `https://auth.callerwhale.com/v1/mfa/telegram/webhook/<secret>`). Without SMTP, email codes are not offered; without the bot, Telegram is not.

## Build order

1. Tables, authenticator devices (3 at most), the challenge flow and email codes, wired into sign-in and the Google step-up. Tests against a fake mail sender.
2. Telegram (fake Telegram in tests).
3. Approvals.
4. The shared client library, then the sign-in step and a Security panel on the website, and the desktop app's sign-in step.
5. Settings examples, docs, publish.

## Not in this plan

Phone push through Firebase Cloud Messaging, SMS, hardware keys (WebAuthn), "remember this device for 30 days". Each is a later addition on the same challenge flow.
