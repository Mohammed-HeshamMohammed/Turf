# Authorization service: its own branch, container and database rights

Status: plan, nothing built. Asked for by the owner on 2026-11-04 and updated the same day with the owner's answers. It works with today's Rust core API and does not wait for any core API rewrite.

## The owner's decisions

1. **Authorization hands out database rights.** For every request it decides which database permissions apply, so the database itself refuses an edit the person is not allowed to make. It keeps its own rules in its own store.
2. **Policy engine: the best choice** (chosen below: SpiceDB behind our own Go service).
3. **It owns teams, projects and far more:** every relationship that says who may reach what.
4. **Everyone's rules:** customers' workspace roles and Caller Whale's own staff roles.
5. **Billing is not in it.** Billing gets its own container and its own language (`billing-service.md`).

## Who does what after the split

| Service | Job |
| --- | --- |
| **Auth** (unchanged) | Proves who someone is: sign-in, sessions, second steps, signs access tokens |
| **Authorization** (new) | Decides what they may do, and which database rights each request gets |
| **Core API** | Holds the CRM data; for each request it asks authorization, then runs the database work under the rights it was given |
| **PostgreSQL** | Enforces those rights: which tables (database roles) and which rows (row security) |
| **Gateway** | Routes unchanged; its staff check asks authorization |
| **Billing** (new, separate plan) | Plans, payments, credits; asks authorization like everyone else |

## How "handing out database rights" works

This is the pattern PostgREST made common: the application logs in with one login that has no rights of its own, and for each request switches to a database role chosen by the authorization decision, so PostgreSQL enforces it.

1. **Database roles, created by the core database's setup scripts** (they cannot log in): `cw_read` (read CRM records), `cw_write` (create and edit CRM records), `cw_import`, `cw_export`, `cw_finance` (money figures), `cw_admin` (workspace settings, members' pages), `cw_staff` (Caller Whale's platform tables), `cw_worker` (job tables). Each has exactly the table rights it needs and nothing else.
2. **The core API's login, `cw_gate`,** has no table rights at all, is not a superuser, does not own any table and does not inherit rights (`NOINHERIT`). It may only switch into the roles above.
3. **Per request,** the core API asks authorization: "this person, this workspace, this action". Authorization answers with a **signed grant**: allowed or not, the database role to use, the record scope (organization, team, project, own, shared), the team and project ids, the capabilities, and a short expiry.
4. **The core API checks the grant's signature,** then opens the transaction with `SET LOCAL ROLE <the granted role>` and sets the scope values that row security reads (today's `callerwhale.org_id`, `callerwhale.scopes`, team and project ids, plus the capabilities). `SET LOCAL` ends with the transaction, so rights never leak into the next request on the same connection.
5. **PostgreSQL enforces:** the role decides which tables can be touched at all; row security with `USING` and `WITH CHECK` on every policy decides which rows can be read and written. A bug in the core API cannot write where the grant does not allow.

Safety rules from the research and PostgreSQL's behaviour:

- Superusers, roles with `BYPASSRLS` and table owners skip row security. So the runtime never uses the owner login; tables are owned by a setup-only role, and `FORCE ROW LEVEL SECURITY` is on anyway.
- Views and functions used by the API are owned by a non-superuser and use `security_invoker`, or a superuser-owned view would bypass row security.
- Every write policy has `WITH CHECK`, not only `USING`.
- Each runtime role gets a `statement_timeout`.
- The grant is signed (EdDSA) by authorization and verified by the core API, and its id is written to the audit log with the change. A compromised core API still holds only `cw_gate`, so it can reach at most the roles `cw_gate` may switch into; the row policies still apply.

This replaces today's arrangement, where the core API reads memberships itself and sets the scope from its own reading.

> **Updated implementation (November 2026):** The authz service now stores rules directly in the existing private PostgreSQL resource. It creates `authz_*` tables at startup and does not require a SpiceDB application. The SpiceDB design below is retained as historical planning context.

## Policy engine: SpiceDB, behind our own Go service

**Choice:** SpiceDB as the rules engine, with a small Go service (`authz`) in front of it that every other service calls. Nobody talks to SpiceDB directly.

Why, from the research:

- Our rules are **relationships**: person is a member of a workspace with a role; a role grants capabilities; a person belongs to teams and projects; a lead belongs to a team or project, is assigned to someone, is handed off, or is shared with a client; staff roles cover all workspaces. That is the relationship-based model (Google's Zanzibar) that SpiceDB and OpenFGA implement. Cedar and OPA fit attribute rules, and comparisons note Cedar has no built-in relationship graph.
- Between the two Zanzibar engines, SpiceDB is described as the most faithful implementation, with strong consistency and a Watch API. **Consistency matters here:** removing someone must take effect at once, and the Watch API lets authorization tell the core API to raise the workspace's access revision immediately.
- SpiceDB is written in Go and stores its data in PostgreSQL, so it fits what we already run.
- Custom roles per workspace (today's `roles` table with chosen capabilities) are modelled as relations, a standard SpiceDB pattern.

Costs and checks before committing:

- One more container (SpiceDB) and its database; self-hosted SpiceDB is rated medium-to-high to operate at very large scale. At our size it is one container.
- **Proof of concept first:** model the hardest case (a caller who sees only their own leads plus leads handed to them, a client who sees only shared leads, a staff member with second step) in SpiceDB and in OpenFGA. If SpiceDB is awkward for our model, OpenFGA (CNCF project, also Go, also PostgreSQL) is the fallback.
- Today's rules (`access.rs`: capabilities, presets, scopes, restrictions, which roles need a second step) are ported unchanged in meaning; the proof of concept must reproduce them exactly.

## What moves, read from today's code

| Today in the core API | Moves to authorization |
| --- | --- |
| `access.rs`: capabilities, role presets (solo, researcher, caller, closer, manager, owner, client), scopes, restrictions, second-step requirement | Rules in SpiceDB's schema plus the Go service |
| `auth.rs` `with_organization`: reads `memberships` and `roles` | Replaced by a grant request |
| Tables `memberships`, `roles`, team and project membership, `users.platform_role` | Relationships in SpiceDB |
| Lead assignment, handoffs, client shares (today read by `callerwhale_visible_lead()`) | Stay as CRM data in the core database for row security; authorization receives a relationship copy only where a decision needs it |
| Routes that change access: `/admin/members`, `/admin/roles`, `/admin/teams`, `/platform/staff`, `/organizations/trial` (invitations live in the auth service; the old `/invitations/join` token path is gone) | Writes become calls to authorization; the paths stay in the core API |

Stays in the core API: the CRM records, organizations and the `access_revision` counter, row security, and every route path the apps use. Billing moves to its own service.

## The containers

| Item | Authorization (`authz`) | SpiceDB |
| --- | --- | --- |
| Folder | `services/authz` | notes in `deploy/spicedb` |
| Language | Go | SpiceDB's own image (Go) |
| Port | 8104 (billing's scaffold already uses 8103) | 50051 (gRPC), private |
| Coolify app | `authz`, alias `authz` (backend environment) | `spicedb`, alias `spicedb` (Database environment, beside PostgreSQL) |
| Branch | `authz-backend-production` (service at the branch root: Base directory `/`, Dockerfile `/Dockerfile`) | None: a Docker Image resource (`authzed/spicedb`) |
| Domain | **None**, not in the gateway's `ROUTES` | **None** |
| Database | Its own database and login, for the grant audit log | Its own database and login (`callerwhale_spicedb`) |
| Who may call it | Our services, each with a machine token in `AUTHZ_TOKENS` and an allow-list | Only `authz`, with SpiceDB's preshared key |
| Copies | At least two | One to start |
| Logs | The shared `callerwhale-log` runner | Its own logs to Grafana |

### What `authz` answers (private HTTP, JSON)

| Request | Answer | Callers |
| --- | --- | --- |
| `POST /v1/grant` with person, workspace and action | Signed grant: allowed, database role, scope, team and project ids, capabilities, second-step requirement, expiry, reason when refused | Core API, billing (every signed-in request, cached briefly) |
| `POST /v1/check` and `/v1/check-batch` | Allow or deny with reason | Workers, reports, gateway staff check |
| Writes: members, roles, restrictions, teams, projects, client shares, staff roles | The new state | Core API admin routes, billing (plan changes that change rights) |
| `GET /v1/orgs/{org}/members` | People and their roles | Core API admin pages |
| `GET /.well-known/jwks.json` | The public key that verifies grants | Core API, billing |
| `GET /healthz` | Health, private network only | Coolify |

Every write checks that the person asking may manage access there (the workspace owner, or staff), so a caller cannot grant itself rights by calling it.

### Speed and failure

- Tokens are still verified locally in each service; grants are cached for a few seconds per person, workspace, action and access revision.
- When rights change, `authz` learns it from SpiceDB's Watch API and publishes an event on Redis; the core API raises the workspace's `access_revision`, which already invalidates caches and offline copies.
- If `authz` is down, callers **fail closed**: signed-in requests get "permissions are unavailable, try again", never a guess. Public pages and health checks keep working.

## Order of work

0. **Inventory** every SQL function, row-security policy, query and route that reads or writes memberships, roles, teams, projects, shares or staff roles.
1. **Proof of concept** of the rules in SpiceDB (and OpenFGA as the fallback) on the hardest cases; confirm the choice.
2. **Database roles** in the core database: the `cw_*` roles, `cw_gate`, table grants, `FORCE ROW LEVEL SECURITY`, `WITH CHECK` on every policy, view and function ownership fixed. Tested with the current code still using its existing login.
3. **Build `authz`** and the SpiceDB container, branches, env examples and tests (real PostgreSQL and SpiceDB per test run).
4. **Copy the data** into SpiceDB.
5. **Shadow mode** (one to two weeks): the core API decides as today and also asks for a grant, logging every disagreement.
6. **Switch the core API** to `cw_gate` plus granted roles.
7. **Switch the writes** to authorization; then the gateway's staff check.
8. **Remove** the old tables and reading code from the core API, after the inventory shows no reader left.

Each step is its own commit, can be undone with a setting, and comes with its Coolify steps.

## What the owner does in Coolify (when built)

1. Create the databases and logins for `authz` and SpiceDB (I prepare the SQL; the owner sets the passwords).
2. Create the `spicedb` and `authz` applications: no domains.
3. Set their variables, including `AUTHZ_TOKENS` and SpiceDB's preshared key.
4. Give the core API `CALLERWHALE_AUTHZ_URL=http://authz:8104`, its token, and the `cw_gate` login in `DATABASE_URL`; redeploy.

## Sources

- [PostgREST: overview of the role system](https://docs.postgrest.org/en/v10/auth.html)
- [PostgREST discussion #1750: row security with views](https://github.com/PostgREST/postgrest/discussions/1750)
- [Row-level security recommendations (AWS)](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html)
- [OpenFGA and Cedar comparison (OpenFGA)](https://github.com/openfga/openfga-cedar-comparison)
- [SpiceDB vs OpenFGA (aicoolies)](https://aicoolies.com/comparisons/spicedb-vs-openfga)
- [OpenFGA vs Permify vs SpiceDB 2026 (PkgPulse)](https://www.pkgpulse.com/guides/openfga-vs-permify-vs-spicedb-zanzibar-authorization-2026)
- [Authorization infrastructure compared (InferaDB)](https://inferadb.com/dispatch/authorization-infrastructure-compared/)
- [Top alternatives to AWS Cedar (Oso)](https://www.osohq.com/learn/aws-cedar-alternatives-authorization-tools)
- [OpenFGA vs SpiceDB vs Cerbos vs OPA](https://sph.sh/en/posts/external-authorization-management-systems/)
