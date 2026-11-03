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

## Port plan (2026-11-03)

Where the code lives: `services/auth-go/` (module `callerwhale/auth`) beside the Rust `services/auth/`, until cutover. At deletion the Rust folder goes and this one is renamed to `services/auth`. Both services use the same database and the same `database_setup_history` table; the Go service carries copies of the same numbered SQL files, so whichever starts first brings the schema up to date and the other finds nothing to do. Do not change a numbered file; add a new number to both.

### Decisions that narrow the port

- **Firebase mode only.** The Rust service also keeps its own Argon2id passwords when no Firebase key is set. Production uses Firebase and the owner chose Firebase for sign-up and sign-in, so the Go service always needs `AUTH_FIREBASE_API_KEY` and keeps no passwords. Development and tests use Firebase's own Auth Emulator or a fake server (`AUTH_FIREBASE_IDENTITY_URL`, `AUTH_FIREBASE_TOKEN_URL` already exist).
- **PostgreSQL only.** No SQLite. Tests run against a real PostgreSQL (`AUTH_TEST_DATABASE_URL`; the developer machine has PostgreSQL 18 in `X:\tools\pg`), each test in its own schema.
- **The human check is not in this service.** It is in the gateway.
- **Same contract.** Same routes (`openapi.yaml` and `docs` of the Rust service), same JSON, same error codes, same token claims (`sub email name sid mfa email_verified provider auth_time iss aud iat exp`), issuer `callerwhale-auth`, audience `callerwhale`, EdDSA with `kid` = first 8 bytes of SHA-256 of the public key in hex. A token from either service verifies with either service's keys, so the core API's Rust check (`callerwhale-auth-verify`) does not change, and the signing key (`AUTH_SIGNING_KEY`) is shared during the side-by-side period.

### What we use instead of writing it (open source)

| Part | Library | Why not our own |
| --- | --- | --- |
| Database driver and pool | `github.com/jackc/pgx/v5` | The standard PostgreSQL driver for Go. |
| Access tokens (EdDSA) | `github.com/golang-jwt/jwt/v5` | Signing and checking with issuer, audience and expiry checks built in. |
| Browser access from the sites | `github.com/rs/cors` | CORS is easy to get subtly wrong; this is the common one. |
| Ids | `github.com/google/uuid` | |
| HTTP, JSON, crypto, SHA-256, Ed25519, base64 | Go standard library | Already there. |
| Authenticator codes (phase 3) | `github.com/pquerna/otp` | RFC 6238, with the `otpauth://` link. |
| Telegram (phase 3) | a maintained Telegram library, chosen then | |
| Provider sign-in (phase 4) | `golang.org/x/oauth2` and `github.com/coreos/go-oidc/v3` | The standard OpenID Connect pieces: ID token checks against the provider's keys. |
| Firebase | Firebase's documented REST API with `net/http` | There is no official Go client for the password sign-in endpoints; the Admin SDK covers only server administration and needs a service account. |
| Migrations | a small loader (about 30 lines) over the existing `database_setup_history` table | Every migration tool keeps its own history table; ours must keep the one the Rust service already wrote, so both can run on one database. This is the only thing written by hand that a library could do. |
| Runtime log rows | the shared `access.go` adapter and `callerwhale-log` runner | Already ours, already synchronised (`tools/runtime-log/sync.mjs`). |

### Phases

Each phase ends with its tests green, `go vet`, `gofmt`, and a note here of what is done.

1. **Core** (this phase): config, signing key and JWKS, database and schema loader, access-token check, `GET /healthz /version /.well-known/jwks.json /v1/security`, `POST /v1/accounts`, `POST /v1/sessions` (with the lockout of five failures in 15 minutes), `POST /v1/sessions/refresh` (rotation, reuse ends the session, atomic), `POST /v1/sessions/sign-out`, `GET /v1/sessions`, `POST /v1/sessions/revoke`, `GET /v1/me`, the outbox event, and the confirmation email request. A person who has a second step is refused with a clear 503 until phase 3 (fail closed; it never skips a second step).
2. **Passwords and email**: change password, forgot, reset, email verify and resend, the notification service client.
3. **Second step**: authenticator devices and recovery codes, email codes, Telegram, approval on another device, step-up, `/v1/mfa/*`.
4. **Providers and the desktop handoff**: Google and Apple through Firebase, `/v1/oauth/*`, `POST /v1/handoffs`.
5. **Parity and cutover**: the Rust tests as the checklist (each one ported or shown redundant), the shield's allow-list test against the Go routes, load test of both, the kill tests, side-by-side run, move traffic route by route at the gateway, a week of the old one stopped, then delete it.

Everything above also has to hold the "Cases" listed earlier in this note.

### Phase 1 status (2026-11-03): done

`services/auth-go` has the core: 27 tests against a real PostgreSQL and a fake Firebase, `go vet` and `gofmt` clean. Checked: a token signed here verifies with the Rust `callerwhale-auth-verify` crate that the core API uses (same header, claims and key id); the refresh race (8 parallel requests with one token: exactly one wins); the lockout; a person with a second step is refused with 503, never let in; Firebase down is a 500 and not a failed sign-in; closing a session stops its access token at once. Not done: the Go race detector (needs a C compiler on this machine), a load test, the Docker image build (no Docker here). Next: phase 2.

### Phase 2 and 3 status (2026-11-03): done

Phase 2 (`account.go`): change password, forgot (the same answer for any address, three emails an hour per address), reset (ends every session), email verify (one atomic statement uses the link; Firebase's own codes still work) and resend. Phase 3 (`mfa.go`, `telegram.go`): authenticator devices (three, the fourth removes the oldest), recovery codes (ten, once, only hashes kept), email and Telegram codes, approval on another device, step-up, every `/v1/mfa/*` route. 80+ tests against PostgreSQL pass.

Hardening beyond the Rust service, each with a test:
- **An authenticator code works once.** The time step of the last accepted code is kept (`database_setup/0007_totp_replay.sql`, in both services), so the same code cannot be replayed inside its clock window (RFC 6238 section 5.2).
- **Five tries, counted before the answer is looked at**, in one statement: thirty parallel guesses get five looks between them. A challenge completes once, and an email or Telegram code is used once, even with answers arriving together.
- **Recovery codes** for a lost device (the Rust service gives none in Firebase mode): ten, four groups of five hex digits, typed with or without dashes and capitals, each used once.
- **A hole closed in the Rust service too (`mfa.rs`)**: a session that had not passed a second step (a Google sign-in, or any session opened before one was set up) could add its own authenticator to an account that already had one, pass the step-up with it, and so choose its own second step. Adding a device now needs a session that passed one, read from the session row (not the token, which can be stale). Test in both services.
- Forgot-password cannot be used to fill an inbox; a Firebase outage is a 500, never a "wrong password" or a counted failure.

Left for the review after the build: TOTP secrets are stored as plain base32 (the Rust service does the same); encrypt them at rest with a key derived from a separate setting. Telegram uses two plain HTTPS calls instead of a library (a library would add more code than it saves). Next: phase 4.

### Phase 4 and 5 status (2026-11-03): built and tested, not cut over

Phase 4 (`oauth.go`): Google and Apple with `golang.org/x/oauth2` (code exchange, PKCE for Google, Apple's ES256 client secret) and `go-oidc` (ID token: signature against the provider's published keys, issuer, audience, expiry, then the nonce); Firebase-owned providers through `createAuthUri`; state and one-time codes each used by one statement; the desktop handoff (`POST /v1/handoffs`) reads what the session passed from the session row. Another fix, in both services: a returning person's name was overwritten with the start of their email address when a provider sent none (Apple sends the name once).

Phase 5, what is proven now (all against PostgreSQL 18):
- **Tests:** 100+ in `services/auth-go`; the gateway's allow-list is checked against the Go source and the Rust source; the Rust suite still passes with the same two fixes.
- **Kill test** (`TestKillingTheServiceMidWayLosesNothingThatWasAnswered`): the real binary, 60 sign-ups in flight, killed with no warning three times, restarted on the same database and key. 112 answered sign-ups, every one still signs in; every user has its sign-up event; no session without a person; no handoff left behind.
- **Speed**, one laptop, handler plus PostgreSQL, Firebase a stand-in (so a floor, not a production number): sign-in about 1,900 a second (p50 7 ms, p99 23 ms), refresh about 1,900 a second (p50 8 ms, p99 22 ms), `/v1/me` about 13,000 a second (p50 1 ms). In production a sign-in is dominated by Firebase's own answer time. No Rust figures were measured, so there is no comparison; this is not a claim that it is faster.
- **Rust tests not ported on purpose:** the ones for the Rust service's own password store (`api.rs` local mode, `without_a_firebase_key...`), and the three in `human.rs` (the human check is in the gateway, with its own 13 tests).

### Done in the repository (2026-11-03)

The Rust service is gone from the repository and the Go one lives at `services/auth`. `services/auth/verify` (the token check the core API uses) moved to `services/auth-verify`; its Cargo workspace entry, the Rust service's own tests and the Rust-only parts of the gateway test went with the rest. `auth-backend-production` is now built from the Go code (Coolify: base directory `/`, Dockerfile `/Dockerfile`, port 8101). Older mentions of `services/auth-go` and "the Rust service" below are history. What remains is the Coolify side:

### What is left on the server side

1. **Docker image**: build `services/auth/Dockerfile` (no Docker on the development machine) and read the first real log rows in Coolify against `Design notes/Runtime logs.md`.
2. **Production branch**: done in `tools/production.json`; publish it, then point the Coolify app at the new branch content.
3. **Side by side**: run the Go service on its own name with the same database and signing key (settings are the same names), point the gateway's `auth` route at it, watch real sign-ins (password, Google, Apple, second step, desktop), keep the Rust container stopped but not deleted.
4. **One live sign-in of each kind** (reCAPTCHA through the gateway, Google, Apple, authenticator, email code, Telegram, approval, desktop handoff) with real Firebase, Google, Apple, Telegram and the notification service: none of those are exercised by the tests, only stand-ins.
5. **A week**, then the review (next section) and the deletion: `services/auth`, its Cargo workspace entry, `auth-backend-production` content, the Rust-only env and docs. `services/auth/verify` (the token check the core API uses) moves to `services/core-api` or its own folder first.

Review items collected so far: encrypt TOTP secrets at rest; a closed server (`AUTH_PUBLIC_SIGNUP=false`) still lets a provider sign-in create an account in Firebase and a row here (the core API then refuses a workspace; decide whether to stop it earlier once it is clear how invitations create accounts); per-address limits on password reset and sign-in beyond the gateway's; sign-in codes and recovery codes use SHA-256 of high-entropy values, which is sound, but a keyed hash would also protect a leaked database.
