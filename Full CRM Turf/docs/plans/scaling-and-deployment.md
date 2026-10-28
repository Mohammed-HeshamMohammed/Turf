# Scaling and deployment

**Status:** Proposed. The container and Kubernetes files exist and are checked against Kubernetes' schemas; **nothing has been built as an image or run in a cluster yet** (no Docker or Kubernetes was available where they were written), and there has been no load test. Terraform is waiting on a decision (below).

## Deploying: one branch, one container

Every `*-production` branch (`docs/plans/production-branches.md`) is one container on the VPS. Each carries its own `Dockerfile` and its own `infra/k8s/<part>/` folder.

| Branch | Dockerfile | Build context | Port | Copies it can run |
| --- | --- | --- | --- | --- |
| `landing-web-production` | `landing/web/Dockerfile` | `landing/web` | 8080 | any number |
| `landing-backend-production` | `landing/api/Dockerfile` | `landing/api` | 8095 | **exactly one** (SQLite file in `/data`) |
| `auth-backend-production` | `services/auth/Dockerfile` | `.` (the branch root) | 8101 | any number, on PostgreSQL |
| `notifications-backend-production` | `services/notifications/Dockerfile` | `services/notifications` | 8102 | any number |
| `gateway-backend-production` | `services/gateway/Dockerfile` | `services/gateway` | 8100 | any number |
| `core-api-backend-production` | `services/core-api/Dockerfile` | `.` | 8088 | any number, once uploaded files are shared (below) |
| (same branch, the worker) | `services/core-api/go/Dockerfile` | `services/core-api/go` | 8090 (health) | any number: workers lease their work |

All answer `GET /healthz`. Settings and secrets are environment variables named in `env/*.env.example`.

### Coolify (what you run now)

Turf runs on Coolify at `187.7.72.171`, in the project "Turf". The environments are "production" (the applications), "database" (PostgreSQL and Redis for auth and the core API) and "monitoring" (Grafana). Each application builds its `*-production` branch with the Dockerfile and port from the table above.

**Domains** (since 2026-10-28; Turf has no domain of its own yet, so it lives under `softfix.dev`):

| Address | Application | Port |
| --- | --- | --- |
| `https://turf.softfix.dev` (and `www.`) | landing-web | 8080 |
| `https://turf.softfix.dev/api` | landing-api, with **Advanced → Path prefixes: Keep paths as-is** (it serves `/api/...` itself) | 8095 |
| `https://app.turf.softfix.dev` | core-api: the CRM's website and API | 8088 |
| `https://auth.turf.softfix.dev` | auth | 8101 |
| `https://api.turf.softfix.dev` | gateway | 8100 |
| `https://grafana.turf.softfix.dev` | grafana-proxy (`deploy/grafana`), not set up yet | 8120 |

- **DNS** is in Cloudflare (`softfix.dev` zone): an A record for `turf` and one for `*.turf`, both pointing at the server, both **DNS only** (grey cloud). Coolify's Traefik gets Let's Encrypt certificates itself. Cloudflare's proxy would break these names, because its free certificate covers only one level below `softfix.dev`, and `app.turf.softfix.dev` is two.
- **No `www.` on the two-level names.** Coolify adds a `www.` copy of every domain. Remove it from auth, core-api and gateway: `www.app.turf.softfix.dev` has no DNS, and one failing name holds up the certificate for the rest. `www.turf.softfix.dev` is fine, since the wildcard covers it.
- A domain change takes effect on the next **Redeploy** of that application.
- **Settings and secrets:** each application's settings come from its `env/<part>.env.example`. The secrets come from your local `env/` files (`node tools/env-init.mjs` writes them), and you enter them in Coolify yourself. The database logins are made once by running `env/turf-auth-db.sql` and `env/turf-db.sql` in each database's Terminal (`psql -U postgres`).

### Dokploy

For each branch, create an **Application**: provider Git, the repository, **that branch**, build type **Dockerfile**, the Dockerfile path and context from the table, the port, a domain, and the environment from the matching `env/<part>.env.example` (secrets from `node tools/env-init.mjs`, or your own). Set the health check to `/healthz`. To run several copies, use the application's replicas setting (Dokploy runs on Docker Swarm). Redeploy when the branch changes: `node tools/publish-production.mjs --push` updates the branches from `main`. Menu names differ a little between Dokploy versions.

Run PostgreSQL and Redis as Dokploy databases, or use a managed one (see "Data" below). Give the core API both `DATABASE_URL` (the application login) and `MIGRATION_DATABASE_URL` (the owner login); it migrates at start.

### Kubernetes (when you outgrow one machine)

`infra/k8s/` is Kustomize, generated from `tools/infra.json` by `node tools/gen-infra.mjs` (change the table, run it, commit the result; a test fails if they differ).

```bash
kubectl apply -k infra/k8s                                  # everything, into the namespace "turf"
kubectl -n turf create secret generic auth-env --from-env-file=env/auth.env     # one per part that names a secret
kubectl apply -k infra/k8s/auth                             # one part (what a production branch holds)
```

Set each image's registry and version in `infra/k8s/kustomization.yaml`, and the hosts in the `ingress.yaml` files (they say `example.com`). What each part gets:

- a **Deployment** that never runs below its minimum (`maxUnavailable: 0` on updates), is spread over machines and zones, runs as a non-root user with no extra privileges, and has readiness, liveness and (for the two that migrate their database) startup probes;
- a **HorizontalPodAutoscaler** on CPU (70%), a **PodDisruptionBudget** so a node drain never takes the last copy, a **Service**, and an **Ingress** where the part is public (the core API's allows WebSockets and 25 MB uploads);
- a volume claim where it keeps files: the core API's uploads (`ReadWriteMany`) and the landing API's database.

Resource numbers are starting points. Measure, then change them in the table.

### Terraform (not written yet)

Terraform needs to know *where* the servers are. Once that is decided it will hold: the server(s) and network rules, DNS records for the hosts above, an object-storage bucket for uploaded files, and optionally a managed PostgreSQL; plus cloud-init to install Dokploy (or k3s). **Which provider is the VPS with?** If the VPS already exists and is only ever one machine, Terraform buys little until a second one is added.

## Scaling out

### The application tier scales sideways

What was checked in the code:

- **Sessions are signed tokens** checked with public keys, so any copy can serve any request (`turf-auth-verify`). Nothing sticky.
- **Tenant isolation is per transaction**: every request sets `turf.org_id` with `set_config(..., true)` and row security does the rest, so connection poolers in transaction mode (PgBouncer) work.
- **Live updates**: each copy `LISTEN`s to PostgreSQL and fans out to its own WebSocket clients, so a change made through one copy reaches people connected to another.
- **Workers lease their work** from the API (`/internal/events/claim`, job leases), so several can run.
- **Migrations**: every copy migrates when it starts; sqlx's migrator serialises concurrent runs with a PostgreSQL advisory lock, so copies started together are safe.
- **Redis is optional**: without it the API reads from PostgreSQL.

### What stops a second copy today

| Blocker | Where | Why it matters | Fix | Done |
| --- | --- | --- | --- | --- |
| Uploaded files live on the local disk | `TURF_ARTIFACT_DIR` (`routes/artifacts.rs`, `routes/worker_data.rs`) | A file uploaded to copy A does not exist on copy B | Object storage (any S3-compatible: R2, MinIO, B2). Until then a shared `ReadWriteMany` volume | No |
| Sign-up rate limit is in memory | `SIGNUPS` in `routes/billing.rs` | Each copy counts on its own, so the limit multiplies by the number of copies | A Redis counter | No |
| Landing API keeps a SQLite file | `landing/api/src/store.mjs` | One writer only | Move it to PostgreSQL if the site ever needs two copies | No (runs as exactly one) |
| The gateway does not route yet | `services/gateway/main.go` | It only answers `/healthz` and `/version`; the apps talk to the services directly | Build routing and rate limits | No |
| No read/write split | one `DATABASE_URL` | Replicas would sit idle | See replication below | No |

### The data tier: replication, clustering, partitioning, sharding

These are four different tools for four different problems. In order of when you reach for them:

**Replication** (copies of the data on other machines). Streaming replication gives a standby that can take over if the primary dies (**high availability**), and read replicas that can answer reads (**read scaling**). Do the first before the second: failover protects you from an outage; read replicas only help once reads are the bottleneck. Reads that must see a just-written change (the app's sync and "my data after I saved") stay on the primary; reports and exports are the candidates for replicas, and tolerate a little lag. The API would need a second connection (`DATABASE_READ_URL`) and a choice per query: not built.

**Clustering** (several machines acting as one service). For PostgreSQL that means a managed HA cluster or an operator that runs one (Patroni, CloudNativePG): a primary, standbys, automatic failover, backups and point-in-time recovery, with PgBouncer in front. For Redis, a primary with Sentinel (it is only a cache here). The auth service has its **own database**, so it scales and fails over on its own.

**Partitioning** (splitting one big table into pieces *inside* one database). The tables that grow without limit are the candidates: `source_rows` (every imported list row, the biggest), `change_log`, `audit_events`, `call_events`, `provider_events`, `messages`, `outbox_events`, `usage_events`. Time ranges (month) suit the logs and let old partitions be detached or archived; a hash of `org_id` suits `source_rows`. It is easy to do while the tables are small and painful after: primary keys and foreign keys must include the partition column. **Do this before the data is large**, as a migration written and tested against realistic row counts.

**Sharding** (spreading tenants across *different* databases). Every tenant table already has `org_id`, row ids are UUIDs, and row security is keyed on the organization, so the natural shard key is the organization. The exceptions are a few logs numbered by a `bigserial` shared by every organization (`change_log.seq`, and the audit and outbox ids). The apps only use those numbers as a cursor *within* one organization, so they stay valid inside one cell; under a distributed database such as Citus they would need rework. Two routes: a distributed PostgreSQL (Citus) sharding on `org_id`, or **cells**: each cell is a complete copy of the stack (API, workers, database) serving a set of organizations, with the gateway looking up the cell for each request. Cells fit this design better, and a noisy customer can be moved to a cell of their own. The cross-organization views the owner dashboard uses (`/platform/*`) would have to ask every cell. **Do not shard yet**: it adds real cost and is only needed when one primary can no longer take the writes or the data no longer fits one machine, which is far away. What keeps the door open is already true: `org_id` on every row, no query that joins across organizations in the CRM itself, and no code that compares those log numbers across organizations. Keep it that way.

### Order of work

1. **Now** (one VPS, Dokploy): one copy of each part; PostgreSQL backed up (base backups and WAL archiving, tested by restoring); `TURF_PUBLIC_SIGNUP=false`.
2. **Before a second copy of the core API**: files to object storage; sign-up limiter to Redis; give every part a real load test and tune the resource numbers.
3. **First real customers**: PostgreSQL on an HA cluster with PgBouncer; 2+ copies of each stateless part (Dokploy replicas, or Kubernetes if there is more than one machine); the gateway doing its job.
4. **Data growing**: partition the large tables; read replicas for reports and exports with a read/write split in the API.
5. **One primary is not enough**: cells, one organization set per cell.

Decisions needed from you: the VPS provider (Terraform), whether files go to an object store (and which), whether PostgreSQL is self-hosted in Dokploy or managed, and when to start on partitioning.
