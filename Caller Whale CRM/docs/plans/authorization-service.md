# Authorization service: its own branch and container

Status: plan, nothing built. Asked for by the owner on 2026-11-04. It works with today's Rust core API and does not wait for any core API rewrite.

## The idea in one paragraph

Today the core API both stores who belongs to which workspace and decides what they may do. This plan moves that into a new backend, the **authorization service** (`authz`), built from its own production branch (`authz-backend-production`) into its own Coolify container. It has **no public address**: no domain and no entry in the gateway's routes, so no person can reach it. Only our own services call it, each with its own machine token. The core API keeps the CRM data and keeps filtering records, but it asks the authorization service who the person is in the workspace and what they may do.

## Who does what after the split

| Service | Job |
| --- | --- |
| **Auth** (unchanged) | Proves who someone is: sign-in, sessions, second steps, signs access tokens |
| **Authorization** (new) | Decides what they may do: memberships, roles, capabilities, record scope, restrictions, teams and projects a person belongs to, staff roles |
| **Core API** | Holds the CRM data and enforces the decision: it checks the token, asks authorization, then sets the scope on each database transaction so PostgreSQL row security filters the records |
| **Gateway** | Unchanged routes; its staff check moves to asking authorization (last step) |

This is the usual split between a place that decides (authorization) and a place that enforces (core API and the database). Record-by-record filtering stays in the core database because the records are there: `callerwhale_visible_lead()` reads leads, handoffs and shares, and it keeps reading the scope, team ids and project ids that the core API sets per transaction. Only where those values come from changes.

## What moves, read from today's code

| Today in the core API | Moves to authorization |
| --- | --- |
| `access.rs`: capabilities, role presets (solo, researcher, caller, closer, manager, owner, client), scopes, restrictions, which roles need a second step | All of it, ported as is, same names and same meaning |
| `auth.rs` `with_organization`: reads `memberships` (roles, restrictions, teams, projects, expiry) and `roles` (capabilities, scope) | The reading and the combining; the core API calls authorization instead |
| Tables `memberships`, `roles` | Authorization's own database |
| `users.platform_role` (staff) | A staff-role table in authorization |
| Routes that change access: `/admin/members`, `/admin/roles`, `/admin/teams`, `/platform/staff`, `/invitations/join`, `/organizations/trial` (creates the owner's membership) | Their writes become calls to authorization; the pages and paths stay in the core API, so the apps do not change |

What stays in the core API: organizations, subscriptions and suspension (billing standing), the CRM records, the `access_revision` counter, row security, and every route path the apps use.

## The new service

| Item | Value |
| --- | --- |
| Folder | `services/authz` |
| Language | Go, like auth and the gateway |
| Port | 8103 |
| Coolify app | `authz`, in the backend environment, network alias `authz` |
| Branch | `authz-backend-production`, built by `tools/publish-production.mjs` with the service at the branch root (Base directory `/`, Dockerfile `/Dockerfile`) |
| Domain | **None.** Not in the gateway's `ROUTES` |
| Database | Its own database and login (`callerwhale_authz`), never shared with another service |
| Copies | At least two, so one restart is not an outage |
| Logs | The shared `callerwhale-log` runner, like every service |
| Settings | `env/authz.production.example`, with entries in `env/container-notes.json` and `env/container-variable-inventory.json` |

### What it answers (private HTTP, JSON)

| Request | Answer | Used by |
| --- | --- | --- |
| `POST /v1/context` with person and organization | Member or not; roles; capabilities; scopes; team and project ids; whether a second step is required; a revision number | Core API on every signed-in request (cached) |
| `POST /v1/check` with person, organization, capability | Allow or deny, with the reason | Any service needing one yes or no |
| `POST /v1/check-batch` | Several checks in one call | Workers and reports |
| Writes: add, change or remove a member; create or edit a role; set restrictions; team and project assignment; staff roles | The new state | Core API admin routes only |
| `GET /v1/orgs/{org}/members` | The people and their roles | Core API admin pages |
| `GET /healthz` | Health, answered only inside the private network | Coolify |

Every write checks that the person asking may manage access in that workspace (today: the owner, or staff), so a compromised caller cannot grant itself access just by calling it.

### Who may call it

- Each calling service has its own machine token in `AUTHZ_TOKENS` (one for the core API, one for the gateway, one for workers), the same pattern as the notification service's `NOTIFY_TOKENS`.
- The service keeps an allow-list of which caller may use which request: workers may only check, never write.
- A call without a valid token is refused and logged.
- "Only machines can reach it" protects it from the internet. It does not protect against a compromised container on the same network, which is why the tokens, the allow-list and the audit log are part of the design.

### Speed

- The token signature is still checked locally in each service (no call for that).
- The core API caches each context in Redis for a few seconds, keyed by person, organization and revision (the same versioned-key design the core API already uses).
- When access changes, authorization raises the revision and publishes an event on Redis; the core API bumps the workspace's `access_revision`, which already makes old caches and offline copies invalid.
- The call stays on one machine's Docker network, so it is short when healthy. Measure it in step 2.

### When it is down

The core API **fails closed**: signed-in requests get a clear "permissions are unavailable, try again" answer, never a guess. Public pages and health checks keep working. Two copies and the health check make this rare.

## Order of work

0. **Inventory.** List every SQL function, row-security policy, query and route that reads or writes `memberships`, `roles` or `platform_role`. Nothing moves until the list is complete.
1. **Build the service** with its own database, the ported `access.rs` rules and the requests above, plus tests (a real PostgreSQL per test run). Add it to `tools/production.json`, create `authz-backend-production`, add the env example.
2. **Copy the data** one-off from the core database into authorization's database.
3. **Shadow mode** (one to two weeks): the core API keeps deciding on its own and also asks authorization, logging every disagreement. Writes go to both.
4. **Switch reads.** The core API uses authorization's answer and sets the transaction scope from it.
5. **Switch writes.** The admin routes write only through authorization.
6. **Gateway staff check** asks authorization.
7. **Remove the old code and tables** from the core API (`memberships`, `roles` and the reading code), with a new numbered setup script, after the inventory shows no reader is left.

Each step is its own commit, can be undone by switching a setting back, and has its Coolify steps written out.

## What the owner does in Coolify (when built)

1. Create the `authz` database and login (I prepare the SQL; the owner sets the password).
2. Create the `authz` application from `authz-backend-production`: Dockerfile build, Base directory `/`, Dockerfile `/Dockerfile`, port 8103, network alias `authz`, **no domain**.
3. Set its variables, including `AUTHZ_TOKENS`.
4. Give the core API `CALLERWHALE_AUTHZ_URL=http://authz:8103` and its token, then redeploy.

## Questions for the owner

1. **Database:** a separate database and login inside the existing Core PostgreSQL instance (simpler), or its own PostgreSQL instance (stronger separation, one more container)?
2. **Rules engine:** port today's role rules to Go as they are (recommended first), or adopt a policy engine (OPA, Cedar or SpiceDB) from the start?
3. **Teams and projects:** authorization owns who belongs to which team and project; the core API keeps the team and project records themselves. Confirm.
4. **Staff:** Caller Whale's own staff roles move to authorization too. Confirm.
5. **Plans and credits:** stay in the core API (billing), not in authorization. Confirm.
