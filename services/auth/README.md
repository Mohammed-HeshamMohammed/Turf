# Authentication service

**The one source of truth for who someone is**, for every Caller Whale app and service: the desktop app, the CRM in a browser, the website, the core API and every feature service. It runs on its own, with its own database, and nothing else reads that database.

| | |
| --- | --- |
| Language | Rust (Axum) |
| Port | 8101 |
| Data | Its own database: PostgreSQL in production, SQLite on a developer's machine and in tests (the SQL works on both) |
| Contract | `openapi.yaml` |

## What it owns

- Accounts: email (stored lower-case), name, password (Argon2id, 12 characters or more), and whether the email is confirmed.
- Signing in with Google or Apple, and the accounts they are linked to. The desktop app's sign-in through the browser.
- Email confirmation links.
- Two-step sign-in: an authenticator code, plus ten single-use recovery codes.
- Sessions, one per signed-in device. Each session has a refresh token, stored only as a hash. The token changes every time it is used, and an already-used token ends the session, because someone copied it.
- Five failed sign-ins for one email in 15 minutes pause that email.
- The signing key, and the public keys at `/.well-known/jwks.json`.

## How every other service knows who is calling

1. The app signs in here (`POST /v1/sessions`) and gets an **access token** (15 minutes) and a **refresh token** (30 days).
2. It sends `Authorization: Bearer <access token>` to any service.
3. That service checks the token with auth's **public keys**: the signature (EdDSA, Ed25519), the issuer `callerwhale-auth`, the audience `callerwhale` and the expiry. It never calls auth to do this, so people keep working while auth restarts.
   - Rust services use the `callerwhale-auth-verify` crate (`verify/`).
   - TypeScript and Python services get the same small check when they need it.
4. Before the access token expires, the app swaps the refresh token for a new pair (`POST /v1/sessions/refresh`).

Closing a session stops new tokens at once. A token already handed out works until it expires, at most 15 minutes. Auth's own endpoints refuse it at once.

## API

| Method and path | What |
| --- | --- |
| `POST /v1/accounts` | Create an account; returns tokens. Off when `AUTH_PUBLIC_SIGNUP=false` |
| `POST /v1/sessions` | Sign in with email and password, plus `code` once two-step sign-in is on. `kind` is `browser` or `desktop` |
| `POST /v1/sessions/refresh` | Swap a refresh token for a new pair |
| `POST /v1/sessions/sign-out` | End this session (bearer token, or `refresh_token` in the body) |
| `GET /v1/sessions` | This person's open sessions |
| `POST /v1/sessions/revoke` | Close one session (`session_id`), or every other one (`others: true`) |
| `GET /v1/me` | Who the token belongs to |
| `POST /v1/password` | Change the password; closes every other session |
| `POST /v1/mfa/setup`, `POST /v1/mfa/confirm` | Turn two-step sign-in on; returns the recovery codes once |
| `POST /v1/mfa/verify` | Confirm a two-step code for the session already open (after a Google or Apple sign-in); returns an access token that says so |
| `POST /v1/email/verify` | Confirm an email address with the token from the link |
| `POST /v1/email/resend` | A new confirmation link (at most once a minute) |
| `GET /v1/providers` | Which of Google and Apple are set up |
| `GET /v1/oauth/{google,apple}/start?target=website\|app\|desktop&port=` | Send the browser to the provider. `desktop` needs the app's `port` on 127.0.0.1 |
| `GET or POST /v1/oauth/{provider}/callback` | Where the provider sends the browser back (Apple posts a form) |
| `POST /v1/oauth/exchange` | Trade the one-time code from a provider sign-in for tokens (once, within two minutes) |
| `GET /.well-known/jwks.json` | The public keys |
| `GET /healthz`, `GET /version` | Health |

Errors are `{"error": "<a sentence>", "code": "<stable code>"}`, for example `wrong_credentials`, `mfa_required`, `wrong_code`, `too_many_attempts`.

Every new account writes a `user.signed_up` event to the `outbox` table in the same transaction (see `contracts/events.md`), and a password account also writes `notification.requested` with its confirmation link. Sending outbox events to the bus, and so the email itself, comes with the notification service. Until then `AUTH_DEV_TOKENS=true` returns the link's token in the response, for development.

### Google and Apple, and the desktop app

The checks are the core API's, moved here: a single-use state, a nonce and PKCE (Google), the ID token checked against the provider's own keys, issuer, audience and expiry, and a confirmed email required. A provider sign-in signs in the linked account, links the account that already has that confirmed email, or opens a new one.

Auth uses tokens, not cookies, so every way back gets a **one-time code** instead of a session: the website gets `?callerwhale_code=` on `AUTH_WEBSITE_URL`, the CRM in a browser tab on `AUTH_APP_URL`, and the desktop app on `http://127.0.0.1:<port>/callerwhale-sign-in?code=`. Each trades the code at `POST /v1/oauth/exchange`. Failures come back as `oauth_error` (desktop: `error`). A provider sign-in does not count as two-step sign-in.

Auth opens **no workspace**. After signing up (with a password or a provider), the app asks the core API for one with `POST /api/v1/organizations/trial`, or joins an organization with `POST /api/v1/invitations/join` and the invitation's token.

## Run and test

```bash
cargo test -p callerwhale-auth -p callerwhale-auth-verify          # from Caller Whale CRM/, on SQLite
AUTH_TEST_DATABASE_URL=postgres://callerwhale_auth:callerwhale_auth@127.0.0.1:55432/callerwhale_auth_test \
  cargo test -p callerwhale-auth -- --test-threads=1         # the same tests on PostgreSQL
cargo run -p callerwhale-auth -- new-key                     # prints a signing key for AUTH_SIGNING_KEY
bash services/auth/scripts/run-auth.sh                # http://localhost:8101, SQLite file services/auth/auth.db
```

The paste-ready settings for Coolify are in [`env/auth.production.example`](../../env/auth.production.example) (fill the `<...>` values); for a local run `run-auth.sh` reads its settings and signing key from `env/auth.env` (`node tools/env-init.mjs` creates it with a new key; see `env/README.md`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite://auth.db?mode=rwc` | `postgres://...` in production |
| `PORT` | 8101 | |
| `AUTH_SIGNING_KEY` | (none) | Base64 Ed25519 key from `new-key`, or base64 of any 32 random bytes (PowerShell: `$b = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [Convert]::ToBase64String($b)`). **Without it a temporary key is used, and every token stops working when the process stops.** Keep it in the deployment's secret store |
| `AUTH_ACCESS_MINUTES` | 15 | |
| `AUTH_REFRESH_DAYS` | 30 | |
| `AUTH_PUBLIC_SIGNUP` | true | |
| `AUTH_PUBLIC_URL` | `http://localhost:8101` | Where browsers reach this service; Google and Apple return to `<this>/v1/oauth/<provider>/callback`, so register that address with them |
| `AUTH_WEBSITE_URL`, `AUTH_APP_URL`, `AUTH_LANDING_URL` | `http://localhost:8088`, `http://localhost:5190`, `http://localhost:5200` | Where a provider sign-in returns: the old website, the CRM in a browser tab, the public site (`target=landing`, back to its `/signin`) |
| `AUTH_FIREBASE_API_KEY` | | Turns Firebase mode on (docs/plans/firebase-auth.md): the project's Web API key. Only this service has it |
| `AUTH_FIREBASE_IDENTITY_URL`, `AUTH_FIREBASE_TOKEN_URL` | Google's addresses | Only for tests, to point at a fake Firebase |
| `AUTH_DEV_TOKENS` | false | Development only: return confirmation tokens in responses |
| `AUTH_ALLOWED_ORIGINS` | `http://localhost:5190,http://localhost:8088,tauri://localhost,http://tauri.localhost` | Browser origins that may call auth: the CRM, the website and the desktop window. Set the real ones in production |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` | | Google sign-in |
| `AUTH_APPLE_CLIENT_ID`, `AUTH_APPLE_TEAM_ID`, `AUTH_APPLE_KEY_ID`, `AUTH_APPLE_PRIVATE_KEY` | | Apple sign-in (the .p8 key, `\n` for line breaks) |

## Moving people over from the core API

The core API (`services/core-api`) still has its own accounts and sessions, and still works exactly as before. It now also accepts auth's tokens, checked with the keys in `CALLERWHALE_AUTH_JWKS` (or fetched from `CALLERWHALE_AUTH_JWKS_URL`), with the organization in the `x-callerwhale-org` header.

The switch, in order:

1. **Done:** auth runs on its own, and the core API accepts its tokens.
2. Copy everyone across with the same ids: `scripts/import-from-core-api.sh`. Passwords, two-step secrets, recovery codes, confirmed emails and Google/Apple links carry over unchanged. An email that auth already holds under a different id is skipped and listed, never merged. **Checked on a local PostgreSQL:** an account copied from the core API signed in to auth with its old password and its old two-step secret, and the core API accepted the resulting token for the same person, with their roles and plan in their organization. Running the script again changes nothing.
3. **Done:** Google and Apple sign-in, desktop sign-in and email confirmation are here. Accepting an invitation is split: the account is made or signed in here, and joining the organization is the core API's `POST /api/v1/invitations/join`. The core API creates its copy of a person the first time they arrive with an auth token. Still on the core API: marking platform administrators (a CRM-side flag for now).
4. **Done:** the CRM (browser tab and desktop window) and the website sign in, sign up, confirm email and sign out through auth, using `clients/auth-client.js`, and send its token to the core API (live updates included). Checked in a browser against the local PostgreSQL: website sign-up with a trial, email confirmation, joining by invitation as a new person, sign-in with and without a two-step code; the CRM's sign-in, automatic organization, trial for a new person, live-updates socket and sign-out. Google needs real Google credentials to try in a browser; its flow is covered by the tests with a fake provider.
5. **Done:** the core API's own sign-in is gone: no passwords, sessions, cookies, two-step codes, Google or Apple, email confirmation or sign-up there. It accepts only auth's tokens and will not start without auth's public keys. Auth is now the only place an account or a session exists. The core API's old sign-in tables stay, unused, until the import has been confirmed on the production server; then a migration drops them. Caller Whale's own staff (the platform owner and system administrators) are a role on the core API, managed from its admin dashboard (`services/core-api/README.md`).

Organizations, memberships and roles stay with the CRM: auth says **who** someone is, and each service decides **what they may do** there.

## The browser client

`clients/auth-client.js` is the one piece of sign-in code the website and the CRM share: sign up, sign in (with a code when auth asks), Google or Apple through a one-time code, two-step set-up and step-up, email confirmation, refresh and sign-out. The access token stays in memory and is refreshed a minute before it expires, one refresh at a time; the refresh token is kept in the browser's storage so a reload stays signed in, which is why those pages load no scripts from other sites. The website and the CRM each keep a copy, because neither can import across the repository at run time: `node services/auth/clients/sync.mjs` copies it, and the CRM's tests fail if a copy differs. Its own tests: `node --test services/auth/clients/test/*.test.mjs`.

**Firebase mode** (`AUTH_FIREBASE_API_KEY`): this service is the only part that talks to Firebase. The routes are the same; behind them, passwords, email links, authenticator codes and Google go through Firebase's server API (`src/firebase.rs`), each person has a UUID row here with Firebase's uid beside it, and each session keeps its Firebase refresh token server side. Extra routes: `POST /v1/password/forgot` and `POST /v1/password/reset` (the link Firebase emails). Differences: no recovery codes, no Apple, and `target=landing` returns a Google sign-in to the public site's `/signin`. Tests run against a fake Firebase (`tests/common/firebase.rs`). Plan: `docs/plans/firebase-auth.md`.
