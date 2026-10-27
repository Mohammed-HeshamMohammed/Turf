# Authentication service

**The one source of truth for who someone is**, for every Turf app and service: the desktop app, the CRM in a browser, the website, the core API and every feature service. It runs on its own, with its own database, and nothing else reads that database.

| | |
| --- | --- |
| Language | Rust (Axum) |
| Port | 8101 |
| Data | Its own database: PostgreSQL in production, SQLite on a developer's machine and in tests (the SQL works on both) |
| Contract | `openapi.yaml` |

## What it owns

- Accounts: email (stored lower-case), name, password (Argon2id, 12 characters or more).
- Two-step sign-in: an authenticator code, plus ten single-use recovery codes.
- Sessions, one per signed-in device. Each session has a refresh token, stored only as a hash. The token changes every time it is used, and an already-used token ends the session, because someone copied it.
- Five failed sign-ins for one email in 15 minutes pause that email.
- The signing key, and the public keys at `/.well-known/jwks.json`.

## How every other service knows who is calling

1. The app signs in here (`POST /v1/sessions`) and gets an **access token** (15 minutes) and a **refresh token** (30 days).
2. It sends `Authorization: Bearer <access token>` to any service.
3. That service checks the token with auth's **public keys**: the signature (EdDSA, Ed25519), the issuer `turf-auth`, the audience `turf` and the expiry. It never calls auth to do this, so people keep working while auth restarts.
   - Rust services use the `turf-auth-verify` crate (`verify/`).
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
| `GET /.well-known/jwks.json` | The public keys |
| `GET /healthz`, `GET /version` | Health |

Errors are `{"error": "<a sentence>", "code": "<stable code>"}`, for example `wrong_credentials`, `mfa_required`, `wrong_code`, `too_many_attempts`.

Every new account writes a `user.signed_up` event to the `outbox` table in the same transaction (see `contracts/events.md`). Sending outbox events to the bus comes with the notification service.

## Run and test

```bash
cargo test -p turf-auth -p turf-auth-verify          # from Full CRM Turf/, on SQLite
AUTH_TEST_DATABASE_URL=postgres://turf_auth:turf_auth@127.0.0.1:55432/turf_auth_test \
  cargo test -p turf-auth -- --test-threads=1         # the same tests on PostgreSQL
cargo run -p turf-auth -- new-key                     # prints a signing key for AUTH_SIGNING_KEY
AUTH_SIGNING_KEY=... cargo run -p turf-auth           # http://localhost:8101, SQLite file auth.db
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite://auth.db?mode=rwc` | `postgres://...` in production |
| `PORT` | 8101 | |
| `AUTH_SIGNING_KEY` | (none) | Base64 Ed25519 key from `new-key`. **Without it a temporary key is used, and every token stops working when the process stops.** Keep it in the deployment's secret store |
| `AUTH_ACCESS_MINUTES` | 15 | |
| `AUTH_REFRESH_DAYS` | 30 | |
| `AUTH_PUBLIC_SIGNUP` | true | |

## Moving people over from the core API

The core API (`services/core-api`) still has its own accounts and sessions, and still works exactly as before. It now also accepts auth's tokens, checked with the keys in `TURF_AUTH_JWKS` (or fetched from `TURF_AUTH_JWKS_URL`), with the organization in the `x-turf-org` header.

The switch, in order:

1. **Done:** auth runs on its own; the core API accepts its tokens next to its own sessions.
2. Copy everyone across with the same ids: `scripts/import-from-core-api.sh`. Passwords, two-step secrets and recovery codes carry over unchanged. **Checked on a local PostgreSQL:** an account copied from the core API signed in to auth with its old password and its old two-step secret, and the core API accepted the resulting token for the same person, with their roles and plan in their organization. Running the script again changes nothing.
3. Move what still signs people in on the core API into auth: Google and Apple sign-in, email confirmation, accepting an invitation, desktop sign-in, platform administrators.
4. Point the app and the website at auth for signing in.
5. Turn the core API's own sessions off. From then on auth is the only place an account or a session exists.

Organizations, memberships and roles stay with the CRM: auth says **who** someone is, and each service decides **what they may do** there.
