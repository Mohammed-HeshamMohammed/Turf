# Authorization service (authz)

Decides what each person may do in each workspace, and which database rights each request runs under. Auth proves who someone
is; this service decides what they may do. Plan: [docs/plans/authorization-service.md](../../docs/plans/authorization-service.md).

| | |
| --- | --- |
| Language | Go |
| Port | 8104 |
| Rules store | SpiceDB ([deploy/spicedb](../../deploy/spicedb)), schema in `schema.zed`, written at start |
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
| Settings | every key in `env/authz.production.example`, in Coolify only |

## What it answers

All requests need `Authorization: Bearer <the calling service's token>` from `AUTHZ_TOKENS`. Each service may make only some
requests: workers and the gateway only ask; only the core API changes members, roles and staff; billing and the core API set a
workspace's standing.

| Request | Answer |
| --- | --- |
| `POST /v1/grant` `{user_id, org_id, action, second_step_passed}` | Allowed, with a signed grant (EdDSA, audience = the calling service, 60 seconds) carrying the database role, scopes, team and project ids and capabilities; or refused with a code: `not_member`, `suspended`, `second_step_required`, `payment_required`, `no_scope`, `missing_capability`, `not_staff` |
| `POST /v1/check`, `POST /v1/check-batch` | Allowed or not, for a capability, `member`, `manage_access`, `staff` or `manage_staff` |
| `PUT /v1/orgs/{org}/owner` | Sets up a new workspace's roles and its owner (`owner` or `solo`) |
| `GET`/`PUT /v1/orgs/{org}/roles[/{key}]` | The workspace's roles; changing one needs an actor with `admin` |
| `GET /v1/orgs/{org}/members`, `PUT`/`DELETE /v1/orgs/{org}/members/{user}` | Members, their roles, restrictions, teams and projects; changes need an actor with `admin` |
| `PUT /v1/orgs/{org}/standing` | Suspended and payment-required flags (billing, core API) |
| `PUT /v1/staff/{user}` | Caller Whale's staff admins; only the platform owner |
| `GET /.well-known/jwks.json` | The public key that verifies grants |
| `GET /healthz`, `GET /version` | Health and version |

Actions and the database role each runs under: `read` → `cw_read`; `edit`, `assign`, `handoff`, `accept`, `call`, `message`,
`review`, `rules`, `publicComment` → `cw_write`; `import` → `cw_import`; `export` → `cw_export`; `finance` and `pay` →
`cw_finance`; `admin` → `cw_admin`; `platform` → `cw_staff`. `pay` stays open while a plan needs paying.

When SpiceDB cannot be reached, requests get `503 unavailable` and never a grant: callers refuse the person's request.

## Run and test

```bash
go test ./...
```

The SpiceDB test runs against a real SpiceDB: start `spicedb serve-testing` and set `SPICEDB_TEST_ENDPOINT=localhost:50051`.

`service new-key` prints a key for `AUTHZ_SIGNING_KEY`.
