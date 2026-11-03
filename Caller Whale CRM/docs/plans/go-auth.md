# Auth rebuild in Go, on Firebase

Status: plan, nothing built yet. Decided with the owner on 2026-11-03. This replaces an earlier draft that proposed Zitadel; Zitadel is dropped.

## Decisions

1. **Firebase handles normal sign-up and sign-in**: accounts, passwords, email confirmation, password reset and Google and Apple sign-in (as `firebase-auth.md` already plans).
2. **We handle everything else ourselves, in Go**: the second steps (authenticator app, email code, Telegram code, approval on another device, recovery codes), sessions and rotating refresh tokens, our access tokens, the human check and abuse limits. The owner will not pay Google's Identity Platform for second steps; anything wrong inside Firebase itself is Google's to fix, because we only add layers on top.
3. **Language: Go.** Same language as the gateway; chosen for speed of building features.
4. **Delete the old one.** `services/auth` (Rust) and the branch `auth-backend-production` are removed after the Go service passes the checks below, not before. Until then the Rust service stays live and the launch path (reCAPTCHA keys, browser sign-in for the desktop app) does not change.
5. **Do not reinvent the wheel.** Use maintained open-source libraries for every part that has one (list below). We write only the rules that are ours.
6. **Review after the build** for better ideas (last section).
7. **Plan for every kind of use, attack and sudden shutdown** (section "Cases").
8. **Same runtime logs** as `Design notes/Runtime logs.md` (section "Runtime logs").
9. **Licence.** The repository is proprietary and private; every branch carries `LICENSE`. Open-source libraries keep their own licences. Do not modify and offer an AGPL component to users.

## What the Go service is

It is today's `services/auth` in Firebase mode, rewritten. Same public contract (`openapi.yaml`), same database tables, same access-token format (EdDSA JWT, issuer `callerwhale-auth`, audience `callerwhale`, JWKS at `/.well-known/jwks.json`), so the website, desktop app, gateway and core API do not change. Firebase's REST API does the password check and account creation exactly as `firebase.rs` does today.

## Open-source parts to use

| Need | Use | Notes |
| --- | --- | --- |
| HTTP server and routing | Go standard library (`net/http`) | No framework. |
| PostgreSQL | `jackc/pgx` | Plus the SQL files we already have in `database_setup/`. |
| Access tokens (EdDSA) and JWKS | `golang-jwt/jwt` (v5) | Keep today's claims so the core API's Rust check keeps working. |
| Authenticator codes (TOTP) | `pquerna/otp` | Standard RFC 6238. |
| Recovery codes, challenge secrets | `crypto/rand` and `golang.org/x/crypto` | Store only hashes. |
| Rate limits | `golang.org/x/time/rate` or a small maintained limiter | Per email, per address, per route. |
| Telegram | A maintained Telegram bot library | Webhook secret kept. |
| Firebase | Firebase REST (as today), Admin SDK where it helps (disable account, revoke) | Google's own SDK. |
| Logging | The shared runtime-log runner and Go HTTP adapter | See below. |
| Quality | `go test -race`, `govulncheck`, `golangci-lint`, Go fuzz tests | Part of every change. |

The human check (Google reCAPTCHA) is built first, in the Go **gateway**, with per-route scores, and auth becomes reachable only through the gateway. Payments will use the same check with a stricter score.

## Cases the design has to survive

People:
- Invited person signs up, confirms email, signs in on desktop, website and CRM in a browser, on several devices.
- Forgot password, lost authenticator, lost phone, changed email, closed account, account disabled by staff, staff opening a customer workspace.
- Offline desktop: signed-in work continues until the access token expires; sign-in itself needs the server.
- Two tabs, back button, expired link, clicking an old email link twice, wrong clock on the computer.

Attacks:
- Password guessing and credential stuffing (lockout, gateway rate limits, human check).
- Account enumeration (same answer whether an address exists, for sign-in, reset and sign-up).
- Reset or invitation link abuse (single use, short life, no token in logs or referrers).
- Stolen refresh token (rotation, reuse ends the session, session list, close all).
- Login CSRF, open redirects, a lookalike login page, framing (frame ban in the CSP).
- Another program racing for the desktop loopback port (the one-time code and `state` already built).
- Social login takeover through an unverified email (link only confirmed emails).
- Second step bypass, replayed codes, a lost factor recovered only after proof.
- Flooding sign-in to exhaust the server (gateway limits, bounded work per request).
- Signing key and Firebase service-account key: kept out of GitHub, build variables and logs, rotated on a schedule.

Sudden stops (power cut, forced shutdown, container kill, deploy during sign-in):
- Kill the Go service at any moment: every write is one transaction; no half-created sessions; start again safely.
- Auth down: other services keep checking tokens from cached public keys until the token expires.
- Backup and restore drill for the auth database and the signing key together, proven on a spare before launch.
- Rolling deploy keeps the old container until the new one's healthcheck passes; graceful shutdown finishes in-flight requests.
- Firebase unreachable: sign-in says so plainly; already signed-in people are unaffected.

## Runtime logs

Follow `Design notes/Runtime logs.md`:
- The Go service is wrapped by the shared runner (`callerwhale-log`) with `CALLERWHALE_LOG_SERVICE=Auth`, as every other image is, and uses the Go HTTP adapter for request rows (method, path, status, duration).
- Never log request headers, cookies, bodies, tokens or email addresses. The source must not emit them; redaction is a second line of defence.
- Failed sign-ins, lockouts, human-check refusals and refresh-token reuse are `[REJECTED]` or `[WARN]` rows with a short reason and no secret.
- Keep standard maintenance commands (`health`, `new-key`, `setup-database`) printing their own CLI output.
- When deployed, record in that note what was actually deployed.

## Order of work

1. Human check in the Go gateway (reCAPTCHA, per-route score); auth only reachable through the gateway.
2. Go auth, porting in this order with the Rust tests as the specification (71 tests, ported to Go against the same fake Google, Apple and Firebase servers): tokens and JWKS, sign-up, sign-in, refresh, `/v1/me`; password reset and email confirmation; second steps; Google, Apple and the desktop handoff; Firebase calls.
3. Run both side by side on one database; move traffic route by route at the gateway; roll back by switching the route back.
4. Kill-test: stop the containers mid-sign-in on purpose, restore from backup, try the abuse cases above.
5. Load test the Rust and Go versions with the same script.
6. Switch production. Keep the old service stopped, not deleted, for one week.
7. **Review after the build** (below).
8. Delete: `services/auth`, the `auth-backend-production` branch and its Coolify app, the Rust-only env files and tests; keep or move the token-check crate the core API still uses (`callerwhale-auth-verify`) until the core API has its own; update `service-architecture.md`, the READMEs and the runtime-logs coverage table.

## Review after the build

Before step 8, go through the whole result and write down: what is slower or heavier than expected, what is confusing to a person signing in, what we wrote that a maintained library already does, what Firebase offers that we did not use, and what can be removed. Turn the findings into changes before deleting the old service.
