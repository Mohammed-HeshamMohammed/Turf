# Core API rebuild in Go, on one database link

Status: plan, nothing built yet. Written 2026-11-04 from the owner's request. Auth and the gateway are already Go; the core API is the last server written in Rust.

## Decisions

1. **Replace the Rust core API with Go.** `services/core-api/rust` (about 9,900 lines in `crates/api`, plus the `grouping` crate) is rewritten in Go, the same language as auth, the gateway and the job worker (`services/core-api/go`). One language to build, test and deploy.
2. **The core API uses one database link: `DATABASE_URL`.** No separate `DATABASE_SETUP_URL`. Auth already works this way.
3. **Database structure is created only by the system or by authorised owners.** The tables are created by the service's own setup step, at startup or by a `setup-database` command run by an owner (as auth does). No request from a signed-in person can create or change tables. What a person creates through the API (records, notes, lists, jobs) is data, and it is checked against who they are (see "Who may create what").
4. **Delete the Rust one last.** `services/core-api/rust`, `services/auth-verify` (the Rust token check) and the Rust parts of `core-api-backend-production` are removed only after the checks below pass. Until then the Rust service stays live.
5. **Same contract.** `contracts/api-v1.yaml` and the routes the website, the desktop app and the gateway use do not change. The rebuild is invisible to them.
6. **Do not reinvent the wheel.** Maintained open-source libraries wherever one exists; we write only our own rules.
7. **Mail is sent only by the notification service.** The core API never talks to a mail server and holds no mail setting. When it needs an email sent (an invitation, a contact-form message, a billing notice) it calls the notification service **through the gateway**, with only what the message needs: the template name, the address, and the data for the wording. The notification service owns the mail login and the wording.

## What the rebuild covers

Today's route files, each ported as a group (`crates/api/src/routes`): `identity`, `records`, `sync`, `reports`, `artifacts`, `billing`, `platform`, `admin`, `desktop_access`, `public`, `worker_data`, `internal`. Plus `ops.rs` (the largest, 1,386 lines), the auth-token check (`auth.rs` and `services/auth-verify`), the cache and live-updates socket, mail, and the 15 numbered files in `rust/database_setup/`.

The job worker in `services/core-api/go` is already Go. It joins the new service's module rather than being rewritten.

## One database link, and what it means

- A single `DATABASE_URL`. The service creates and updates its own tables when it starts, under a PostgreSQL advisory lock so two copies starting together do not both run the setup. Same pattern as auth.
- **The trade-off the owner must accept.** With one link, the login the service uses is also the one that owns the tables. If the service were ever taken over, the attacker could change the database structure, not only the data. The two-link design (a restricted runtime login, a separate owner login for setup) prevented that. This plan therefore keeps the damage small in code and by rule:
  - The request-handling code contains no `CREATE`, `ALTER` or `DROP`. A test fails the build if any appears outside the setup step.
  - The setup step is the only place that changes structure. It runs numbered, checksummed scripts once each, in order, and refuses to start if a script that was already applied has changed.
  - The database is reachable only on the private Coolify network, never from the internet.
  - If the owner later wants the stronger version back, a restricted role can be added without changing the code: the setup step reads `DATABASE_SETUP_URL` only when it is set, and falls back to `DATABASE_URL`.

## Who may create what

Two different kinds of "create":

| Kind | Examples | Who | How it is enforced |
| --- | --- | --- | --- |
| **Structure** (tables, columns, indexes) | a new numbered setup script | the system at startup, or an authorised owner running `setup-database` | only the setup step can do it; no route can |
| **Data** (records, lists, notes, jobs, invitations, settings) | a person adds a lead | signed-in people allowed to, by role | every route checks the token, the organisation (`x-callerwhale-org`) and the role before it writes, and records who did it in the audit log |

Roles stay as they are today (owner, member, staff, platform roles); staff routes keep the second-step requirement. A person whose membership was removed loses access on their next request, because every request reads the membership.

## Mail goes through the gateway

- **Today** (`mail.rs`): the core API already sends no mail itself, but it posts to `CALLERWHALE_NOTIFY_URL` (`https://notify.callerwhale.com`) with its own token, straight to the notification service's public domain. The gateway never sees these calls.
- **Wanted:** the gateway is the only public door for every server, so the notification service gets **no public domain of its own**. `notify.callerwhale.com` becomes a route on the gateway (`ROUTES` gets `notify.callerwhale.com=http://notifications:8102`), and the gateway forwards `POST /v1/mail` to it. The core API keeps the same URL and token, so nothing in the Go port changes except that the call is made by a small `mail` package with one function, `Send(template, to, data)`.
- **Who may call it:** the notification service still checks the caller's token (`NOTIFY_TOKENS`: one token for auth, one for the core API); the gateway adds its rate limits and logs the call. The gateway should answer only `POST /v1/mail` and its health check on that host, the way it answers only auth's real routes on the auth host (a follow-up change in `services/gateway`).
- **What the core API sends:** `{"template": "invitation", "to": "...", "data": {...}}` and nothing else. No HTML, no mail-server details, no password. New kinds of message are new templates in the notification service.
- **When it fails:** the core API does not retry in a loop and does not lose the request: the email is recorded in the outbox table with its template and data, a worker retries it with backoff, and a message that cannot be sent is shown to the owner in the admin operations list.
- **Auth** follows the same rule (`AUTH_NOTIFY_URL`), moved to the gateway route in the same change.

## Open-source parts to use

| Need | Use | Notes |
| --- | --- | --- |
| HTTP server and routing | Go standard library (`net/http`) | No framework, as in auth and the gateway. |
| PostgreSQL | `jackc/pgx` | Plus the existing numbered SQL files. |
| Access-token check (EdDSA, JWKS) | `golang-jwt/jwt` v5 with the auth service's `/.well-known/jwks.json` | Same claims auth signs today; replaces the Rust `callerwhale-auth-verify` crate. |
| Live updates socket (`/events`) | `coder/websocket` | Same sub-protocol list (`callerwhale.v1`, `bearer.<token>`, `org.<id>`). |
| Redis cache and invalidation | `redis/go-redis` | PostgreSQL stays the source of truth. |
| Rate limits | `golang.org/x/time/rate` | Per person, per address, per route. |
| Billing webhooks | the payment provider's Go library | Signature check stays mandatory. |
| Tests | Go `testing` against a real PostgreSQL | The Rust integration tests (`crates/api/tests`) are ported case by case. |

## Cases the design has to survive

- **Two copies starting at once**: the advisory lock makes one run the setup; the other waits.
- **A setup script that failed halfway**: each script runs in one transaction, so nothing is half applied; the service refuses to start and says which script.
- **A script changed after it was applied**: the checksum differs, so the service refuses to start.
- **The database is down**: health check fails, the proxy stops sending traffic, requests get a clear 503, no data is guessed.
- **Someone calls a route with another organisation's id**: the organisation check refuses it; tested for every route group.
- **A token from the wrong issuer, expired, or signed with a replaced key**: refused with 401; keys are re-fetched when a new key id appears.
- **Sudden shutdown mid-request**: writes are in transactions; the service finishes in-flight requests on SIGTERM.
- **Replays of a billing webhook**: stored by event id, applied once.
- **Large uploads**: the gateway limit (`MAX_BODY_MB`) and a per-route limit both apply.

## Runtime logs

Same adapter as every other service (`Design notes/Runtime logs.md`): the container runs behind `callerwhale-log`, `/healthz` stays quiet when it succeeds, and the line for a failed request names the real reason (the Rust service already logs `request failed` with it; keep that).

## Order of work

1. **Freeze the contract.** Run the Rust service's tests and save every route's request and answer as the reference the Go service must match (`contracts/api-v1.yaml` is the start; it covers only part of the routes).
2. **Foundation.** Go module `callerwhale/core-api` beside the worker; config, logging, database connection, the setup step with the advisory lock and checksum rule, health, the token check against auth's keys.
3. **Port by route group**, smallest first, each with the Rust tests ported and the same JSON checked against the reference: `public`, `identity`, `records`, `sync`, `reports`, `artifacts`, `billing`, `platform`, `admin`, `desktop_access`, `internal` and `worker_data`, then the live-updates socket and the cache.
4. **Run both side by side.** The new service answers a copy of the traffic on a private address; the gateway can route one host to either; differences are read from the logs.
5. **Cut over** by switching the gateway's `ROUTES` entry for the core API to the Go service, with the Rust service kept running for a week.
6. **Delete the old one.** `services/core-api/rust`, `services/auth-verify`, the Rust `Dockerfile`, their Cargo workspace entries, the Rust-only env files and tests; update `production-branches.md`, `scaling-and-deployment.md`, the READMEs and `tools/production.json`.

## Review after the build

Check for simpler designs once it runs: whether any route group can be merged, whether the live-updates socket needs Redis, and whether the restricted-role option should come back.

## Open questions for the owner

1. **Reading of the request.** "look the data creation in the database to the system or the authorized owners" was read here as: *only the system or authorised owners can create structure*, and signed-in people create data through the API within their role. If the intent was different (for example, that ordinary members must not create data at all), say so before step 3.
2. **One link or two.** This plan follows the one-link decision and keeps the stronger option available. Confirm the owner accepts the trade-off above.
3. **The desktop app is also Rust** (the Tauri window container and feature modules). This plan does not touch it; it is a separate decision.
4. **Timing.** The sign-in 500 on the live system is a configuration problem in the current Rust service (its database setup URL) and does not wait for this rebuild.
