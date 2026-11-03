# Auth rebuild on Zitadel

Status: plan, nothing built yet. Decided with the owner on 2026-11-03.

## Decisions

1. **Delete the old auth.** `services/auth` (Rust) and its branch `auth-backend-production` are removed once the new one has passed the checks below. Not before: until then it keeps running and keeps the launch working.
2. **Do not reinvent the wheel.** Sign-in, accounts, sessions, authenticator codes, social login, recovery and the audit trail come from an open-source identity server, **Zitadel** (Go, PostgreSQL). What we write is glue: the gateway, the token check in the core API, the screens and the migration.
3. **Review after the build** for better ideas (section "Review after the build").
4. **Plan for every kind of use, attack and sudden shutdown** (section "Cases").
5. **Same runtime logs** as `Design notes/Runtime logs.md` (section "Runtime logs").

Language: Go where we write code (the gateway). Zitadel is Go too. Reasons and the comparison are in the conversation of 2026-11-03: the language makes no measurable difference to a sign-in (the password hash and the database dominate), so speed of building features decided it.

## What replaces what

| Today (`services/auth`, Rust) | After (Zitadel and our glue) |
| --- | --- |
| Accounts, Argon2id passwords, email confirmation, password reset | Zitadel users, its password rules and its emails sent through our mail sender (SMTP) |
| Google and Apple sign-in | Zitadel identity providers |
| Authenticator codes, recovery codes, email code | Zitadel second factors. **Check:** recovery codes, Telegram codes and "approve on another device" may not exist; see "To verify first" |
| Sessions, rotating refresh tokens, theft detection | OIDC refresh tokens and Zitadel sessions. **Check** reuse detection |
| Access token (EdDSA JWT) and `/.well-known/jwks.json` | Zitadel JWT access tokens (RS256) and its JWKS. The core API's token check (`callerwhale-auth-verify`) must change to match |
| Desktop sign-in through the browser (the handoff built on 2026-11-03) | The standard native-app flow: system browser, PKCE, a loopback port on 127.0.0.1. The handoff code and `POST /v1/handoffs` go away |
| reCAPTCHA inside auth | The human check in the Go gateway (separate task, see below) |
| `callerwhale_auth` database | Zitadel's own database in the same PostgreSQL |

## To verify first (a one-day spike, in a throwaway Docker compose)

Nothing below is assumed. Each answer goes in this file.

- **Licence.** Sources disagree (AGPL or Apache). Read the LICENSE file in the official repository. AGPL is fine for running it unchanged; it matters if we modify it.
- **Resources.** Estimates: about 1 GB RAM, 2 vCPU. The VPS has 7.8 GB and 2 cores shared with everything else, so measure.
- **Existing passwords.** Import one Argon2id hash from today's database on the version we will run. Reports from older versions say it was refused. If refused: import users without a password and send a reset email, or migrate each person's password the first time they sign in.
- **Second factors.** Which of authenticator app, email code, recovery codes, passkeys exist. Telegram codes and in-app approvals probably do not; decide whether to drop them.
- **Tokens.** Make Zitadel issue JWT access tokens (not opaque) for our services, with the claims the core API reads (user id, email, whether the second step was passed, provider).
- **Lockout.** Zitadel's own failed-attempt policy, against today's "five failures in 15 minutes pause that email".
- **Sign-in screens and the human check.** Zitadel serves its own login page. Find out how to add reCAPTCHA or put the page behind the gateway's check, and how to give it Caller Whale's look.
- **Desktop.** Native app flow with a loopback redirect works with the Tauri window and `tray` opening the browser (`open_in_browser`).

## Cases the design has to survive

People:
- Invited person signs up, confirms email, signs in on desktop, website and CRM in a browser, on several devices.
- Forgot password, lost authenticator, lost phone, changed email, closed account, account disabled by staff, staff opening a customer workspace.
- Offline desktop: signed-in work continues until the access token expires; sign-in itself needs the server.
- Two tabs, back button, expired link, clicking an old email link twice, wrong clock on the computer.

Attacks:
- Password guessing and credential stuffing (lockout, rate limits at the gateway, human check, breached-password refusal).
- Account enumeration (same answer whether an address exists, for sign-in, reset and sign-up).
- Reset or invitation link abuse (single use, short life, no token in logs or referrers).
- Stolen refresh token (rotation and reuse detection, session list, close all).
- Login CSRF, open redirects, a lookalike login page, a page framed by another site (frame ban in the CSP).
- Another program on the computer racing for the desktop loopback port (PKCE and `state`).
- Social login takeover through an unverified email (link only confirmed emails).
- Second step bypass, replayed codes, SIM-less factors recovered by support only after proof.
- Flooding sign-in to exhaust the server (gateway limits, hashing cost bounded).
- Admin and signing keys: separate from the database, rotated on a schedule, never in GitHub, a build variable or a log.

Sudden stops (power cut, forced shutdown, container kill, deploy during sign-in):
- Zitadel and PostgreSQL stop at any moment: durable writes, no half-created accounts, safe to start again, no data loss from a kill.
- Auth down: services keep checking tokens locally from cached public keys, so people already signed in keep working until expiry.
- Restore drill: back up the database and the master key together; prove a restore on a spare before launch. A backup without the key is useless.
- Rolling deploy keeps the old container until the new one's healthcheck passes.

## Runtime logs

Follow `Design notes/Runtime logs.md`:
- Zitadel is a third-party image. Wrap its start with the shared runner (`callerwhale-log`, `CALLERWHALE_LOG_SERVICE=Auth`) so its output uses the same table (RESULT, SERVICE, PAGE / EVENT, METHOD, HTTP, TIME, DETAIL). Keep its exit codes and signal handling unchanged.
- Keep one Auth label. Our own Go code (gateway, glue) uses the Go HTTP adapter.
- Never log request headers, cookies, bodies, tokens or email addresses. Redaction is a second line of defence; the source must not emit them.
- Failed sign-ins, lockouts and reuse of a refresh token are logged as `[REJECTED]` or `[WARN]` rows with a short reason, never the secret.
- When deployed, add Auth's new image to the Coverage table in that note and record what was actually deployed.

## Order of work

1. Spike (above). Write the answers here. Free disk space first: drive X: is nearly full and Docker needs room.
2. Human check in the Go gateway, with per-route scores (also for future payments). Auth is reachable only through it.
3. Core API token check: accept Zitadel's JWTs (JWKS, issuer, audience, claims).
4. Switch clients: website sign-in page, desktop (native flow), CRM. Remove the handoff code.
5. Migrate accounts (passwords as the spike decides) on a copy first.
6. Staging cutover with the case list above as the test list; kill the containers mid-sign-in on purpose.
7. Production cutover. Keep the old auth stopped but not deleted for one week.
8. **Review after the build** (next section).
9. Delete: `services/auth`, the `auth-backend-production` branch and its Coolify app, `env/auth*.example`, `database_setup`, `AUTH_*` variables, the reCAPTCHA-in-auth code; keep or move the token-check crate the core API still uses; update `service-architecture.md`, the READMEs and the runtime-logs coverage table.

## Review after the build

Before step 9, go through the whole result with fresh eyes and write down: what is slower or heavier than expected, what is confusing to a person signing in, what we wrote that Zitadel already does, what Zitadel does that we did not turn on (passkeys, risk checks, audit export, session limits), and what can be removed. Turn the findings into changes before deleting the old service.

## Until then

The current Rust auth stays as it is: reCAPTCHA keys, the new browser sign-in for the desktop app and the Coolify settings are the launch path. Nothing in this plan changes them.

## Update, 2026-11-03 (later)

Owner decisions after the plan above:

- **Licence.** Everything, on every branch including `main`, is proprietary: `LICENSE` at the repository root, copied into every production branch by `tools/publish-production.mjs`, and `"license": "UNLICENSED"` in the npm packages. The repository was made private. Third-party components keep their own licences. **Do not modify Zitadel or any other AGPL component and offer it to users**: AGPL would require offering that modified source to them. Use such software unchanged, and put our own code beside it.
- **Accounts.** The owner wants **Firebase** to hold accounts, passwords and social sign-in (as `firebase-auth.md` already plans), and to add stronger second steps. Firebase and Zitadel cannot both be the place people sign in. Open question: how the extra second steps are added (see the conversation). Until that is answered, nothing here is built.
- **Second steps.** Owner wants to build custom ones. Our existing Telegram code, email code and in-app approval already do this in `services/auth/src/mfa.rs`; Firebase's own authenticator-app step covers TOTP.
- **Tokens, human check, server size.** Adapt or add them when needed; optimise after launch.
