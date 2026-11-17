# Authorization service (authz)

Decides what each person may do in each workspace, and which database rights each request runs under. Auth proves who someone
is; this service decides what they may do. Plan: [docs/plans/authorization-service.md](../../docs/plans/authorization-service.md).

| | |
| --- | --- |
| Language | Go |
| Port | 8104 |
| Rules store | The existing private PostgreSQL resource; `authz_*` tables are created at startup |
| Public address | **None.** Not in the gateway's `ROUTES`. Only Caller Whale's services call it, each with its own token |
| Status | First version. Not yet called by the core API (shadow mode is the next step) |

## Coolify

| Setting | Value |
| --- | --- |
| Source | branch `authz-backend-production` |
| Build pack | Dockerfile |
| Base directory | `/` |
| Dockerfile location | `/Dockerfile` |
| Port | 8104 |
| Network alias | `authz` |
| Domain | none |
| Settings | every key in `.env.example` on the production branch (source: `env/authz.production.example` on `main`), in Coolify only |

### First deployment and owner

1. Copy the internal connection URL from the existing private PostgreSQL resource into authz's `DATABASE_URL`, with `sslmode=require`. The login needs permission to create and update the `authz_*` tables. The unused SpiceDB server is not needed.
2. Have the owner and cofounder sign in once, then look up each Caller Whale Account ID **in the auth database**, for example `SELECT id FROM users WHERE lower(email) = lower('you@example.com');`. The returned `users.id` looks like `123e4567-e89b-42d3-a456-426614174000` (a UUID). It is also the `sub` of that person's Caller Whale access token. **Do not use the Firebase Authentication UID**: it is stored separately in `users.firebase_uid` and authz rejects it as an owner value. Put the two distinct Caller Whale IDs in `AUTHZ_PLATFORM_OWNER` and `AUTHZ_PLATFORM_COFOUNDER`. Either setting may be added before a later redeploy if that account is not ready. Keep these IDs in server settings, not on the public webpage.
3. Generate `AUTHZ_SIGNING_KEY` with `go run . new-key` from `services/authz`, or use PowerShell `[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))` for a 32-byte Ed25519 seed. Generate separate `billing=` and `auth=` tokens in `AUTHZ_TOKENS`. Copy each token to the matching service's `AUTHZ_TOKEN`; never put secrets in Git.
4. Set the authz application with the Coolify settings above, paste the filled `.env.example` from the production branch, and deploy. Its startup creates its tables and fills only empty owner and cofounder slots. Check the startup log for role assignment and for a healthy container.

The owner and cofounder roles are for the Caller Whale platform. They are distinct from a customer's workspace owner. Changing their environment values cannot replace the people already assigned; the service logs a warning if a slot is taken.

## What it answers

All requests need `Authorization: Bearer <the calling service's token>` from `AUTHZ_TOKENS`. Each service may make only some
requests: workers and the gateway only ask; only the core API changes members, roles and staff; billing and the core API set a
workspace's standing.

| Request | Answer |
| --- | --- |
| `POST /v1/grant` `{user_id, org_id, action, second_step_passed}` | Allowed, with a signed grant (EdDSA, audience = the calling service, 60 seconds) carrying the database role, scopes, team and project ids and capabilities; or refused with a code: `not_member`, `suspended`, `second_step_required`, `payment_required`, `no_scope`, `missing_capability`, `not_staff` |
| `POST /v1/check`, `POST /v1/check-batch` | Allowed or not, for a capability, `member`, `manage_access`, `staff`, `manage_staff` or `tester` |
| `PUT /v1/orgs/{org}/owner` | Sets up a new workspace's roles and its owner (`owner` or `solo`) |
| `GET /v1/orgs/{org}` | The workspace's owner and agency name, so auth can say on an invitation where it comes from (`read`) |
| `PUT /v1/orgs/{org}/name` | Keeps the agency's name as the CRM has it; only crm-core sets it (`manage`) |
| `PUT /v1/orgs/{org}/features/{name}` | Turns a workspace's switch on or off (`manage_staff`); `teams_v2` is the new team rules. `AUTHZ_FEATURES_EVERYWHERE=teams_v2` turns it on for every workspace |
| `PUT /v1/orgs/{org}/teams/{team}/deputies` | Names a team's deputy leads: its leads, an admin or the owner (`manage_members`) |

**New team rules (`teams_v2`, build step 11).** Off by default for each workspace. When on: a team has no lead, one, or several equal leads (`manager_ids`; `manager_id` stays the first) and up to 10 deputy leads; callers, closers and researchers sit in one to five teams; a person can hold several roles (a lead can also call or close); the owner names up to 3 admins (`authz_standing.admins` raises it), who do what the owner does with people and teams but cannot change admins; a lead invites agents into teams they lead and manages their agents but not other leads; a removed or demoted lead simply leaves the team's leads. A grant's `team_scope_ids` are the teams the `team` scope shows: led or deputised teams, and the person's own teams only when a role other than team lead gives the team scope. Staff who own a workspace act in it as its owner, without the staff second step.
| `GET`/`PUT /v1/orgs/{org}/roles[/{key}]` | The workspace's roles; changing one needs an actor with `admin` |
| `GET /v1/orgs/{org}/members`, `PUT`/`DELETE /v1/orgs/{org}/members/{user}` | Members, their roles, restrictions, teams and projects; changes need an actor with `admin` |
| `PUT /v1/orgs/{org}/standing` | Suspended and payment-required flags (billing, core API) |
| `GET /v1/people/{user}` | Who this person is: their place on the platform (`platform_role`, `platform_label`) and their roles in each workspace (`business_owner` is true for the workspace's owner). Auth reads this for the signed-in person's website dashboard. |
| `PUT /v1/staff/{user}` | Assign or remove `system_admin` and `tester`; platform owner or cofounder only |
| `GET /v1/staff` | List platform roles for the private auth bridge and core API |
| `GET /.well-known/jwks.json` | The public key that verifies grants |
| `GET /healthz`, `GET /version` | Health and version |

Actions and the database role each runs under: `read` → `cw_read`; `edit`, `assign`, `handoff`, `accept`, `call`, `message`,
`review`, `rules`, `publicComment` → `cw_write`; `import` → `cw_import`; `export` → `cw_export`; `finance` and `pay` →
`cw_finance`; `admin` → `cw_admin`; `platform` → `cw_staff`. `pay` stays open while a plan needs paying.

When PostgreSQL cannot be reached, requests get `503 unavailable` and never a grant: callers refuse the person's request.

## Who is who: the ladder

| Who | Stored as | What they can do |
| --- | --- | --- |
| **Caller Whale owner** | platform `owner` (exactly one) | Gets Caller Whale's staff pages (`platform` grant), manages system admins and testers, and passes `staff`, `manage_staff` and `manage_access`. The database prevents changing or deleting this row. |
| **Cofounder** | platform `cofounder` (exactly one) | Same staff page and staff management rights as the owner, but cannot change either permanent role. The database prevents changing or deleting this row. |
| **System admin** | platform `system_admin` | Gets Caller Whale's staff pages (`platform` grant) and passes `staff` and `manage_access`. Cannot manage platform roles. |
| **Tester** | platform `tester` | Identified by the `tester` check. Does not receive the `platform` grant or staff database rights. |
| **Agency owner** | workspace role `owner` (or `solo`) | Runs one workspace and manages its members and roles. The role cannot be given, changed or removed, and no other role can manage access. |
| **Manager, closer, caller, researcher, client, or a custom role** | workspace roles | Only the capabilities and records their role allows (see the table of actions above). |

Passing `manage_access` is for callers deciding what to show. **Changing** a workspace's members or roles still needs the person asking to be an `admin` member of that workspace (in practice its agency owner); the staff roles do not bypass that yet. Giving staff a supervised way into a workspace is a decision for later.

Platform staff grants and the agency owner need the second step (`AUTHZ_STAFF_SECOND_STEP`, `AUTHZ_REQUIRE_SECOND_STEP`).

**Setting the permanent roles (once).** Neither owner nor cofounder can be assigned through an API request. Set `AUTHZ_PLATFORM_OWNER=<person id>` and `AUTHZ_PLATFORM_COFOUNDER=<person id>` before startup, or run `docker exec <authz container> /service set-owner <person id>` and `... /service set-cofounder <person id>`. Each id is the `sub` of that person's sign-in token. A redeploy with a different value does not replace the existing person. PostgreSQL also rejects updates and deletes of these two rows.

## Run and test

```bash
go test ./...
```

The PostgreSQL integration test uses a dedicated disposable database set by `AUTHZ_TEST_DATABASE_URL`.

`service new-key` prints a key for `AUTHZ_SIGNING_KEY`.
