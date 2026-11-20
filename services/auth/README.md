# Auth

The authentication service, in Go. It replaced the Rust service that used to live here. Plan, decisions, phases and what is left: [docs/plans/go-auth.md](../../Caller%20Whale%20CRM/docs/plans/go-auth.md).

| | |
| --- | --- |
| Language | Go (standard library, `pgx`, `golang-jwt`, `rs/cors`, `google/uuid`) |
| Port | 8101 |
| Data | PostgreSQL only (`database_setup_history` plus the numbered SQL in `database_setup/`) |
| Accounts | Firebase holds accounts and passwords (always needs `AUTH_FIREBASE_API_KEY`); this service keeps no passwords |
| Human check | Not here. The gateway checks reCAPTCHA; this service has no setting for it |
| Settings | [env/auth.production.example](../../Caller%20Whale%20CRM/env/auth.production.example) |
| Token check for other services | `packages/go/authverify/` (Go, copied into each Go service that checks tokens, today the gateway); `clients/` (JavaScript sign-in client, copied into the apps by `clients/sync.mjs`) |

## What is built

Every route (the gateway's allow-list in `services/gateway/shield.go` is checked against this source):

- Sign-up, sign-in, refresh, sign-out, sessions, `/v1/me`, JWKS, `/v1/security`, health (phase 1).
- `GET /v1/me/access` returns only the signed-in person's platform role and workspace memberships from private authz. Set `AUTHZ_URL` and an auth read token in `AUTHZ_TOKEN`; unavailable authz returns 503 without inventing access.

If the profile says authorization is unavailable (503), check auth's logs for `WARN roles unavailable`. The log distinguishes missing `AUTHZ_URL`/`AUTHZ_TOKEN`, a network failure, authz refusing the machine token (HTTP 401/403), or an invalid upstream response; no token or account ID is logged. Authz must be running, reachable at its private `AUTHZ_URL`, and configured with an `auth=<same token>` entry in `AUTHZ_TOKENS`.
- `GET /v1/admin/staff` lists platform staff for a signed-in owner, cofounder, or system admin who passed a second step. `POST /v1/admin/staff` accepts an existing account email and `system_admin`, `tester`, or an empty role; only owner and cofounder may change roles. Auth resolves the account ID privately and authz enforces the permanent founder roles.
- Platform founders can invite future staff through `/v1/admin/invitations`; workspace owners can list members, change member roles, and invite people through `/v1/orgs/{org}/...`. Invites live in auth PostgreSQL for at most one hour from creation. They are bound to a verified email and applied by authz only when the recipient accepts from `/v1/me/invitations`. An inviter who loses authority cannot grant access through an old invite. The response distinguishes an emailed invite (`sent`) from a send that failed (`failed`) and one saved while email is off (`not_configured`), and carries the invitation's `link`.
- Each invitation keeps the agency's name and its owner's name as they were when it was sent (read from authz, which the CRM tells), and shows who sent it. The email names the agency and links to `/dashboard?invitation=<id>`. `GET /v1/me/invitations/{id}` is that invitation, or the reason it cannot be used: `other_address` with the invited address masked (`m•••••@gmail.com`), `email_unverified`, `cancelled`, `accepted`, `expired`. Before the address is confirmed, `GET /v1/me/invitations` says only `waiting`. The invited person can report an invitation to staff (`POST /v1/me/invitations/{id}/report`); staff read reports at `GET /v1/admin/invitation-reports`. Accepting answers with the `org_id` joined.
- Every invitation the agency sees has a `status`: `pending`, `blocked` (accepting it would fail now, for example its team is gone or the plan lost seats; `status_reason` says why, asked of authz as the inviter with earlier invitations holding their seats), `expired`, `declined` or `cancelled`. Ended ones stay in the agency's list for a week. The agency can resend a waiting invitation once an hour, three times (`POST /v1/invitations/{id}/resend`), and extend it twice by its full validity from now (`.../extend`). Each agency sets how long invitations last, 1 to 30 days, 7 by default (`/v1/orgs/{org}/invitation-settings`); at most 50 new invitations a day, which only staff raise. The invited person can decline (`POST /v1/me/invitations/{id}/decline`) or block the agency for good (`/v1/me/blocked-agencies`, undone with DELETE). When someone is removed, suspended, or stops being a team lead, the invitations they sent and that are still waiting are cancelled; the invited person sees only "This invitation was cancelled", and no email goes out.
- An invitation carries everything (`roles`, `team_ids`, and for a team lead `lead_team_ids`); accepting makes the person a member with those roles and teams, then a lead of those teams (`teams_not_led` lists any that could not take them). A team lead invites callers, closers and researchers into the teams they lead, sees and handles the invitations they sent, and when every seat is taken the owner is asked for one (`/v1/orgs/{org}/seat-requests`). A lead taken off a team has their waiting invitations into it cancelled. Anyone but the owner can leave an agency (`POST /v1/orgs/{org}/leave`).
- **Name tags and privacy (build step 4).** Every person has a `#tag` after their name (`Alex Morgan#K7P2`), four letters and digits without 0, O, 1 and I; name and tag together are unique, with look-alike characters counted as the same, and the database gives one to every account (`database_setup/0027_name_tags.sql`). The tag is in `/v1/me`, the access token (`tag` claim), the members list and the owner's name on an invitation. `POST /v1/me/tag` changes it; a name and a tag can each be changed twice in 30 days (not counting an account's first day), and a full name someone stops using is held for them for 90 days. A new name that would match someone else's full name keeps the name and gets a free tag. `PUT /v1/me/privacy` sets who sees the phone number (only returned to those allowed), who can find the person and who can message them; `GET /v1/people/search?q=` finds people of one's own agencies by part of a name, and anyone by exact `Name#tag` unless they chose agencies only, 30 exact look-ups an hour.
- **Step 15.** An invitation email's link carries a one-time key (`&key=`; the agency's own copy of the link never does, and sending again replaces it). With it, `GET /v1/invitations/{id}/preview` shows the invited address and agency before anyone signs in, and `POST /v1/accounts` with `invitation_id` and `invitation_key` makes the account with that address already confirmed, even where sign-up is otherwise closed; the key then stops working. Sign-in (`kind: "shared"`, or `device: "shared"` on `/v1/oauth/exchange`) can be for a shared device: that session lasts 12 hours at most and token answers say `device: "shared"`, so the website keeps it only while the tab is open; otherwise sessions last `AUTH_REFRESH_DAYS` (30). An owner's, admin's, team lead's or staff member's second step counts for 7 days: a refresh after that keeps the session but drops the second step, and they give their code again. `GET /v1/me/agencies` lists the person's agencies by name with roles and teams (My access); `GET /v1/me/export` is a file with their own data.
- **AI limits (step 24).** A connector with `team:manage` reads an agency's people and teams (`POST /v1/connectors/people`, the MCP service only) and asks for changes (`POST /v1/connectors/requests {kind: invite|remove|change_roles|delete_team|cancel_invitation, args}`); nothing that spends money can be asked for. The person sees them at `GET /v1/me/ai-requests` and confirms (`/approve`, which makes the change through this service's own routes with their sign-in) or refuses (`/reject`); a request ends after a day.
- **Support access (step 19).** The owner lets Caller Whale's support in with `POST /v1/orgs/{org}/support {hours}` (second step), sees it with `GET` and ends it with `DELETE`; staff list the agencies open to them at `GET /v1/admin/support`.
- **Unpaid and closed agencies (step 18).** `GET /v1/orgs/{org}/plan-stage` tells the agency's people where it stands (the grace period only to the owner and admins); the owner closes it with `POST /v1/orgs/{org}/close` (second step; waiting invitations end) and reopens it with `/reopen` within 30 days. When a lowered plan leaves more people than seats, `GET /v1/orgs/{org}/seats` (owner, admins) shows who uses one, and `POST /v1/orgs/{org}/seats/keep {keep}` (the owner, second step) suspends everyone else (D81, D365).
- **Ownership (step 13).** `POST /v1/orgs/{org}/handover {to, old_role: admin|manager|leave}` (the owner, with the second step) offers the agency to a member for 7 days; `GET`/`DELETE` the same path shows or cancels it. `GET /v1/me/handovers` lists offers to the person; `POST /v1/me/handovers/{id}/accept` (second step) makes them the owner through authz, but when billing says the agency pays through the provider and its payer is someone else it answers `409 payment_needed`; `/decline` ends it. Staff pause an agency whose owner cannot be reached with `PUT /v1/admin/workspaces/{org}/paused {on}`; after that an admin may `POST /v1/orgs/{org}/takeover`, and the platform owner or cofounder approves at `POST /v1/admin/takeovers/{id}/approve` once the agency has been paused 14 days (`GET /v1/admin/takeovers`, `/reject`).
- `POST /v1/me/profile` saves a display name in Firebase and auth, plus an optional phone and PNG/JPEG picture (up to 500 KB) in auth's PostgreSQL. `GET /v1/me/providers` reads linked Google/Apple methods from Firebase. `POST /v1/me/providers/{provider}/start` binds a provider link to the current session and requires a sign-in from the last 15 minutes; the callback verifies Firebase kept the same account ID.
- Change password, forgot, reset, email verify and resend (phase 2).
- Every `/v1/mfa/*` route: authenticator devices, recovery codes, email and Telegram codes, approval on another device, step-up (phase 3).
- `/v1/providers`, `/v1/oauth/*` (Google and Apple, direct or through Firebase) and `POST /v1/handoffs` for the desktop app (phase 4).

## Coolify

| Setting | Value |
| --- | --- |
| Source | branch `auth-backend-production` |
| Build pack | Dockerfile |
| Base directory | `/` |
| Dockerfile location | `/Dockerfile` |
| Port | 8101 |
| Health check | the image has one (`/service health`); or HTTP `/healthz` on 8101 |
| Settings | every key in [env/auth.production.example](../../Caller%20Whale%20CRM/env/auth.production.example), in Coolify only |

The service creates and updates its own tables when it starts, so it only needs an empty PostgreSQL database and its role. The gateway does the human check.

Deploy authz's `manage_members` right and notifications' `team_invitation` template before this auth version. Auth's existing `AUTHZ_URL`, `AUTHZ_TOKEN`, `AUTH_NOTIFY_URL`, `AUTH_NOTIFY_TOKEN`, and `AUTH_LANDING_URL` settings are used; no browser receives a machine token. `AUTH_PUBLIC_SIGNUP` must allow account creation if invitees do not already have accounts.

## The contract

Routes, JSON, error codes and sentences, the access token (EdDSA, issuer `callerwhale-auth`, audience `callerwhale`, claims `sub email name sid mfa email_verified provider auth_time iss aud iat exp`, key id from the public key), the lockout (five failed sign-ins for one email in 15 minutes), refresh-token rotation with theft detection, the signing key (`AUTH_SIGNING_KEY`, so tokens from either service verify with either's keys).

## Different on purpose

- An authenticator code works once (the time step of the last accepted code is kept); answers to a second-step challenge are counted before they are looked at, so parallel guesses cannot get more than five tries; recovery codes exist for a lost device.
- A session that never passed a second step cannot add its own authenticator to an account that has one.
- A returning person keeps their name when a provider sends none (Apple sends it once).
- A refresh is one conditional `UPDATE`: of two requests with the same token exactly one wins, the other looks like a copied token and ends the session.
- The schema loader holds a database lock, so several instances starting together do not race.
- A stop signal finishes the requests in flight, then closes (20 seconds at most).
- Anything that is not one of our own refusals is logged and answered as "Something went wrong."; request bodies, headers and tokens are never logged.

## Run and test

```bash
cd services/auth
go vet ./... && go test ./...        # PostgreSQL tests are skipped without AUTH_TEST_DATABASE_URL
AUTH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres go test ./...   # each test gets its own schema
DATABASE_URL=postgres://... AUTH_FIREBASE_API_KEY=... go run .
go run . new-key                      # prints a value for AUTH_SIGNING_KEY
AUTH_LOAD=1 go test -run Load -v      # how fast (the handler and PostgreSQL, Firebase a stand-in)
go test -run Killing -v               # kills the real binary mid-work three times and checks nothing answered was lost
```

`go run . health` is the container's health check (the image has no shell). The Firebase Auth Emulator can stand in for Firebase in development: set `AUTH_FIREBASE_IDENTITY_URL` and `AUTH_FIREBASE_TOKEN_URL` to it.

Build the image with this folder as the context: `docker build -t callerwhale-auth services/auth`. Logs follow `Design notes/Runtime logs.md` (the shared runner and `access_log.go`, both generated by `tools/runtime-log/sync.mjs`).

## Adding to it

A new numbered SQL file goes in `database_setup/`; a route added here goes in the gateway's allow-list (`services/gateway/shield.go`; its test compares that list with this source).

## Status page and breach notices (build step 34)

- `GET /v1/status` (open): each part (sign_in, crm, calls, texts, chats, email) up, degraded or down; open incidents (the `banner`) and the last 30 days'. The website's `/status` page and every page's outage banner read it.
- Staff: `POST /v1/admin/status/incidents {components, severity: degraded|down, title, message}`, `POST /v1/admin/status/incidents/{id} {message, resolved}`. Opening and resolving email everyone who chose it: `GET`/`PUT /v1/me/status-emails {on}`.
- `STATUS_PROBES` (optional): `part=private health address,...`, checked every minute; two failures in a row show the part down until it answers.
- Staff: `POST /v1/admin/breach-notices {org_ids, discovered_at, what, to_do}` emails each agency's owner now and keeps whether it went within 72 hours of `discovered_at`; `GET /v1/admin/breach-notices` lists them with their deadline.

## Sign-in security (build step 35, part A)

- Each session keeps its device ("Chrome on Windows"), country (Cloudflare's `CF-IPCountry`) and network (the address cut to its first parts). A sign-in from a device the person never used emails them (`new_sign_in`) with a "This wasn't me" link to the website's `/account/not-me`, which calls `POST /v1/sessions/not-me {token}`: that session ends and a password reset email goes out.
- `POST /v1/orgs/{org}/members/{user}/sign-out`: the owner or an admin (with their second step) ends every session of a member; an admin cannot sign out the owner.
- `GET`/`PUT /v1/orgs/{org}/security {idle_minutes, mfa_everyone}`: the owner sets the idle limit (15 minutes to 7 days, 8 hours by default) and requires the authenticator of everyone (kept in authz as the `mfa_everyone` switch). A refresh after the shortest limit of the person's agencies ends the session (`signed_out_idle`), counted from the last refresh or from the app's `idle_seconds`; `on_call: true` never times out.
- `POST /v1/password/reset {token, new, code}`: someone with an authenticator app or recovery codes also gives a code. Lost both: `POST /v1/password/reset/support {token, reason}`; staff see `GET /v1/admin/reset-requests` and `POST /v1/admin/reset-requests/{id}/approve|refuse`, approving only after 7 days, which removes the lost authenticator and recovery codes, signs the person out everywhere and emails a reset link.

## Sign-in security, part B (build step 35)

- Microsoft sign-in and linking: `/v1/oauth/microsoft/start` and `/v1/me/providers/microsoft/start` go through Firebase's own authorization flow (no client here). It shows once Microsoft is turned on in Firebase (an Azure app registration whose redirect is Firebase's handler).
- `PUT /v1/orgs/{org}/security {countries, networks}` (the owner): where the agency's members may work from. Authz keeps them; the gateway checks each request inside the agency against Cloudflare's country and the real address, the owner excepted.

## Help and feedback (build step 40)

- Support conversations (D292): `GET/POST /v1/orgs/{org}/support-chats` (the owner and admins; members are told to ask their owner), `GET /v1/support-chats/{id}`, `POST /v1/support-chats/{id}/messages`, `POST /v1/support-chats/{id}/close`; staff list them at `GET /v1/admin/support-chats` (owner or cofounder, second step). A staff reply emails whoever opened it (notifications template `support_reply`).
- What's new (D293, D309): staff write notes (`POST /v1/admin/whats-new {title, body, roles, feature, kind}`); `GET /v1/whats-new?org=` gives a person the notes they have not seen: for their roles (owners every note), and a note tied to a switch only where it is on. `POST /v1/whats-new/{id}/seen`. A small terms change is a note of kind "terms"; a big one still changes `termsVersion`, which asks everyone again.
- Early features (D294): `GET /v1/orgs/{org}/early-features`, `PUT …/{name} {on}` (the owner, second step), kept in authz as switches.
- Feedback (D295): `POST /v1/feedback {note, page, version, org_id}` keeps only the page's path with ids taken out; 20 a day per person. Staff: `GET /v1/admin/feedback`, `POST /v1/admin/feedback/{id}/handled`.
