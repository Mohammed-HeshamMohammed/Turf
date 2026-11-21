# Core API: every function, and the best way found to build each

Status: research for the owner, 2026-11-04. Starts from zero, as asked: what the core API does today (read from `services/core-api/rust`), then for each function what the research found to be the best way to build it, how today's code compares, and which kind of language or tool suits it. Nothing is built or changed.

Quality warning: the sources are mostly vendor documentation, practitioner blogs and forum threads. Where they disagree or give numbers without method, this document says so. Measure on our own data before acting on any figure.

## Summary

| # | Function | Today | Best way found | Verdict | Suits |
| --- | --- | --- | --- | --- | --- |
| 1 | Checking who is asking (tokens) | JWKS from auth, verified locally | Same, plus refetch on unknown key id and pinned algorithms | **Keep**, small hardening | Go |
| 2 | Permissions and tenant isolation | Role capabilities in code + PostgreSQL row-level security | RBAC in code + row-level security as the backstop | **Keep**: already the recommended design | Go + SQL |
| 3 | Writing CRM changes (operations) | Client-chosen ids, replay returns first answer, field-level conflict check | Idempotency keys + optimistic concurrency | **Keep**: matches best practice | Go |
| 4 | Offline sync | Change log with cursor, access revision | Cursor change log for relational data; sync engines (PowerSync) as an option; CRDTs only for document editing | **Keep**; consider PowerSync only if the client sync code grows | Go |
| 5 | Audit, change log, outbox in one transaction | Yes, every committed change | Transactional outbox, polling first, CDC (Debezium) only for sub-second needs | **Keep** | Go + SQL |
| 6 | Live updates (WebSocket) | PostgreSQL LISTEN/NOTIFY fan-out | Fine at modest load; NATS or Redis Streams past roughly 5,000 commits a second | **Keep now**, plan the switch | Go |
| 7 | Cache | Redis, keys carry org + access revision + data revision, falls back to the database | Versioned keys (generation counters) per tenant | **Keep**: already best practice | Go |
| 8 | Background jobs and scheduler | Leases with `FOR UPDATE SKIP LOCKED`, renew, progress, fail | PostgreSQL `SKIP LOCKED` queue with leases and idempotent handlers | **Keep**; consider the River library in Go | Go |
| 9 | Rules and automation | Database-backed rules with dry runs and runs | Database-backed jobs for simple rules; Temporal only for long multi-step workflows | **Keep** | Go |
| 10 | Reports and dashboards | SQL per report kind, run live | SQL; materialized views refreshed hourly when slow; ClickHouse or DuckDB only at very large scale | **Keep SQL**, add views when measured slow | SQL |
| 11 | Search | `ILIKE '%term%'` across name, phone, email, address | PostgreSQL full-text search + `pg_trgm` indexes; Meilisearch or Typesense only if typo tolerance is core | **Change**: add trigram indexes | SQL |
| 12 | Files (artifacts) | Local disk, content-addressed by SHA-256 | S3-compatible object storage (SeaweedFS or Garage self-hosted) once there is more than one copy of the API | **Change** before scaling out | Go |
| 13 | Billing, plans, credits, webhooks | In the core API | Build metering and webhooks in-house for simple credits; Lago if invoicing grows complex | **Keep**, revisit with invoicing | Go |
| 14 | Matching, deduplication, grouping | Grouping crate (Rust), comparisons in Python or an unseen C++ engine | Batch engine: blocking + pairwise scoring + union-find; Splink (Python + DuckDB) handles millions of rows | **Separate engine**, batch only | C++, Rust or Python/DuckDB |
| 15 | Database structure setup | Numbered scripts, checksums, advisory lock | Same, plus lock timeouts, concurrent index builds, expand-contract | **Keep**, add the safety rules | SQL |
| 16 | Admin, platform, public forms, mail | Routes in the core API; mail via the notification service | Same; mail only through notifications (already decided) | **Keep** | Go |
| 17 | Serving the website | The core API serves `/srv/website` with its policy | Static files from nginx or a CDN; the API serves only the API | **Change**: move out | nginx/CDN |

**Overall:** most of the core API is already built the way the research recommends. The real gaps are search (no indexes), files (single-disk storage blocks running several copies), the website being served by the API, and a known ceiling on live updates. None of these needs C++. The one function that does suit a compute language is matching and grouping, and it should be a separate batch engine.

## The functions in detail

### 1. Checking who is asking

**Today:** every request carries auth's access token; the core API checks it with auth's public keys (`CALLERWHALE_AUTH_JWKS` or fetched from `CALLERWHALE_AUTH_JWKS_URL`) and refuses to start with a bad key set.

**Best way found:** cache the key set in memory and pick the key by `kid`; refetch when a token arrives with an unknown `kid` (rate-limited), not only on a timer; accept any key in the set during rotation; pin the accepted algorithms; check `iss`, `aud`, `exp` with small clock skew, only after the signature; treat the key endpoint as a dependency with timeouts and serve from cache through short outages. Use a maintained library rather than custom caching.

**Gap:** keys are fetched once at start. A key rotation in auth needs a core API restart. Add refetch on unknown `kid`.

### 2. Permissions and tenant isolation

**Today:** role presets with capabilities and record scope (`access.rs`), checked in code; PostgreSQL row-level security is on for the tenant tables, reading `callerwhale.org_id` set per transaction, and `callerwhale_visible_lead()` for record scope.

**Best way found:** AWS's guidance treats row-level security as the standard for tenant isolation in a shared database, with a per-request tenant setting rather than a database user per tenant. Practitioners recommend RBAC in code plus row-level security as the backstop, because one forgotten `WHERE` clause otherwise leaks data. Relationship-based engines (OpenFGA, SpiceDB) or policy engines (Cedar, OPA) only when fine-grained sharing becomes a proven need; keeping their data in sync with the main database is a real cost.

**Caveat to check:** row-level security does not apply to superusers, roles with `BYPASSRLS` or, by default, the table owner. If the core API connects as the table owner (one database link), add `FORCE ROW LEVEL SECURITY` or keep a separate non-owner login, or the backstop is off.

### 3. Writing CRM changes

**Today:** every change is an operation with a client-chosen id; a replay returns the first answer as "duplicate"; field edits carry the base value and become a conflict when the server value moved (`ops.rs`). Online requests, offline queues and rule actions share this path.

**Best way found:** idempotency keys for creates and optimistic concurrency (version or base value, `If-Match` and 412 over plain HTTP) for updates. The current design is both.

### 4. Offline sync

**Today:** push applies operations one by one with per-operation answers; pull returns changes after a cursor, filtered by current access; an access-revision bump forces a fresh snapshot.

**Best way found:** for an existing relational database, a change log with a cursor is the plain, proven pattern, with conflicts resolved by the server. Sync engines such as PowerSync sit in front of PostgreSQL (logical replication) and keep a SQLite copy on the client while writes still go through the backend; they remove client-side sync code. CRDTs suit collaborative document editing, not relational CRM records. ElectricSQL has changed direction and is not a stable choice.

**Verdict:** keep. Consider PowerSync only if the desktop app's own sync code becomes a burden.

### 5. Audit, change log and outbox

**Today:** every committed change writes an audit event, a change-log row, an outbox event and a live notification in the same transaction (`record.rs`).

**Best way found:** this is the transactional outbox pattern. Start with polling the outbox (simple, about 100 ms latency); move to change data capture (Debezium reading the write-ahead log) only when sub-second delivery is required, at the cost of running Kafka Connect and managing replication slots. Delete or time-partition published outbox rows so the table does not grow forever.

**To check:** that published outbox rows are cleaned up or partitioned.

### 6. Live updates

**Today:** PostgreSQL `NOTIFY` at commit; each core API copy listens and fans out to its WebSocket connections after checking each person may see the lead.

**Best way found:** fine for modest load and small payloads (8 KB cap, send ids). One source puts the ceiling around 5,000 commits a second, where the global commit lock during `NOTIFY` becomes the bottleneck; past that, NATS or Redis Streams. Listeners must use a direct or session-pooled connection, not transaction pooling. These figures come from blogs and are unverified.

**Verdict:** keep; measure commit rate; move to Redis Streams (Redis is already running) when it approaches the ceiling.

### 7. Cache

**Today:** Redis; keys include organization, access revision and data revision, so a role change or edit makes old entries unreachable; any Redis failure is a cache miss, never an error.

**Best way found:** versioned keys (generation counters) per tenant are the recommended multi-tenant approach: invalidation is one increment, no race between delete and write, no cross-tenant wildcard deletes. Old entries expire by TTL, so set TTLs.

### 8. Background jobs and scheduler

**Today:** jobs claimed with `FOR UPDATE SKIP LOCKED` and a lease (10 to 900 seconds), renewed, with progress, complete and fail; workers reach the database only through `/internal` routes; a scheduler tick emits overdue tasks.

**Best way found:** PostgreSQL with `SKIP LOCKED`, leases, heartbeats and idempotent handlers is the recommended default when PostgreSQL is already there, with the advantage of enqueueing in the same transaction as the data. Redis queues win only at very high job volumes (benchmarks conflict). In Go, River is a maintained library for exactly this.

### 9. Rules and automation

**Today:** stored rules with runs and dry runs, executed through the operations path.

**Best way found:** database-backed scheduled jobs for simple, periodic rules; a workflow engine such as Temporal only for long-running, multi-step workflows with external waits, because it needs its own persistence store and operations. A custom rules engine is justified when rules are user-configurable and part of the product, which is the case here.

### 10. Reports and dashboards

**Today:** a fixed SQL statement per report kind, run live under the person's scope; CSV export of leads.

**Best way found:** PostgreSQL is better at fetching records by known patterns; columnar databases (ClickHouse) at aggregates over very large data. A practical path: dashboards query materialized views refreshed hourly or nightly, which one source says lasts to about a billion rows; DuckDB for offline analysis on exported files; ClickHouse only for high-volume real-time aggregation. PostgreSQL materialized views block reads during refresh unless refreshed `CONCURRENTLY` with a unique index.

**Verdict:** reports are database work, so the language does not matter much. Keep SQL; add materialized views when a report is measured slow.

### 11. Search

**Today:** `ILIKE '%term%'` on lead name, phone, email and address, and on task titles. A leading `%` cannot use a normal index, so every search scans the table.

**Best way found:** PostgreSQL full-text search plus `pg_trgm` (trigram) indexes, which do serve `ILIKE '%term%'` and give fuzzy matching, with no extra service to run. Meilisearch or Typesense when typo tolerance, facets and search-as-you-type are central to the product; they index a copy that must be kept in step.

**Verdict:** add `pg_trgm` GIN indexes on the searched columns. This is the clearest performance win in this list.

### 12. Files

**Today:** uploaded files stored on the container's local disk under `CALLERWHALE_ARTIFACT_DIR`, content-addressed by SHA-256. The README already notes the API can run several copies only once files are shared.

**Best way found:** S3-compatible object storage, so any copy can read any file, with presigned URLs so large downloads skip the API. MinIO's community edition has been archived; self-hosted alternatives in use are SeaweedFS (Apache-2.0, S3 endpoint with little setup) and Garage (single binary, AGPL-3.0, no web console). Content addressing by SHA-256 carries over unchanged.

**Verdict:** change before running more than one copy of the core API.

### 13. Billing, plans, credits and webhooks

**Today:** plans, checkout, payment webhook, call start and end, monthly credits for desktop access, all in the core API.

**Best way found:** building usage billing in-house is described as months of work once proration, credit notes, tax and invoices are involved. Lago is a full open-source billing platform (metering, invoicing, prepaid credits); OpenMeter covers metering and entitlements only. Licences differ by source (check: Lago reported as AGPL-3.0). Webhooks must be idempotent (stored by event id, applied once).

**Verdict:** today's needs (monthly credits, a payment provider's checkout) are small; keep in-house. Revisit Lago if invoicing, proration or tax arrive.

### 14. Matching, deduplication and grouping

**Today:** the `grouping` crate (Rust, 277 lines) assembles pair decisions into groups identically on the API, in workers and in offline Skip Tracing; pair comparisons run in Python or a C++ batch engine whose source is not in this repository.

**Best way found:** entity resolution is done in batches: blocking (only compare likely candidates), pairwise scoring, then clustering (union-find style). Splink, a Python package running on DuckDB or Spark, reports linking a million records on a laptop in about a minute and has been run at hundreds of billions of comparisons. No source compared C++ and Python engines directly.

**Verdict:** this is the one function that suits a compute language. Run it as a **separate batch engine** called once per job, never per request. Whether that engine is C++, Rust or Python on DuckDB should be decided by a benchmark on our own lists, against Splink as the reference.

### 15. Database structure setup

**Today:** numbered scripts applied in order, checksums kept, PostgreSQL lock held during setup.

**Best way found:** same, plus a `lock_timeout` on every statement, `CREATE INDEX CONCURRENTLY` outside a transaction, never changing a column type in place, and the expand-contract pattern (old and new app versions both work against the database during a change). pgroll automates expand-contract for PostgreSQL.

### 16. Admin, platform, public forms and mail

Members, teams, roles, projects, settings with history, templates, integrations, audit, operations; staff pages for organizations, people, payments, waitlist and activity; the website's waitlist and contact forms. These are ordinary database-backed routes. Mail already goes only through the notification service; the gateway route for it is in `go-core-api.md`.

### 17. Serving the website

**Today:** the core API serves the website's files from `/srv/website` and sets its Content Security Policy.

**Best way found:** static files belong on a web server or CDN (as the landing site already does with nginx); the API serves only the API, so a website change does not rebuild or restart the API.

## Language fit, from the research

- **Functions 1 to 9, 13, 16:** network and database work: request in, database, answer out. Any compiled language is fast enough; the time is spent in PostgreSQL. This is the work Go is built for.
- **Functions 10, 11, 15:** SQL. The language around it does not change the speed; indexes and query plans do.
- **Function 12:** a storage service (SeaweedFS or Garage), called from Go.
- **Function 14:** compute over large batches. A separate engine in C++, Rust or Python with DuckDB, chosen by benchmark.
- **Function 17:** nginx or a CDN.

## What to do first, by gain

1. Search: `pg_trgm` GIN indexes on the searched columns (function 11).
2. Row-level security check: confirm the core API's database login is not the table owner, or add `FORCE ROW LEVEL SECURITY` (function 2).
3. Key refresh on unknown `kid` (function 1).
4. Files to S3-compatible storage before running several copies (function 12).
5. Website out of the API (function 17).
6. Benchmark the matching engine options on real lists (function 14).

## Sources

- [Row-level security recommendations (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html)
- [PostgreSQL Row-Level Security for Multi-Tenant SaaS (DEV)](https://dev.to/endurance-softwares/postgresql-row-level-security-for-multi-tenant-saas-3gc1)
- [Multi-tenant permissions architecture](https://zendevy-rebuild.pages.dev/en/architecture/multi-tenant-permissions/)
- [How we rewrote OpenFGA in pure Postgres](https://getrover.substack.com/p/how-we-rewrote-openfga-in-pure-postgres)
- [ElectricSQL vs PowerSync (PowerSync)](https://powersync.com/blog/electricsql-vs-powersync)
- [ElectricSQL vs PowerSync vs Replicache](https://telemetry-landing.pages.dev/blog/electricsql-vs-powersync-vs-replicache/)
- [Local-first apps, CRDT and sync engine guide 2026](https://devtoollab.com/blog/local-first-apps-crdt-sync-engine-guide-2026)
- [SKIP LOCKED vs Redis: when should you use a database queue (HackerNoon)](https://hackernoon.com/skip-locked-vs-redis-when-should-you-use-a-database-queue)
- [Do You Really Need Redis? (Atomic Object)](https://spin.atomicobject.com/redis-postgresql/)
- [Building background job systems without Redis using PostgreSQL](https://www.c-sharpcorner.com/article/building-distributed-background-job-systems-without-redis-using-postgresql/)
- [Transactional outbox: database-Kafka consistency (Conduktor)](https://conduktor.io/blog/transactional-outbox-pattern-database-kafka)
- [Outbox pattern for reliable event publishing (Conduktor)](https://www.conduktor.io/glossary/outbox-pattern-for-reliable-event-publishing)
- [Postgres LISTEN/NOTIFY scales: when to drop Redis for fan-out (Groundy)](https://groundy.com/articles/postgres-listen-notify-scales-when-to-drop-redis-for-job-fan-out/)
- [SignalR.PostgreSQL backplane](https://github.com/Nodsoft/SignalR.PostgreSQL)
- [Handling optimistic concurrency with ETags (Ed-Fi)](https://docs.ed-fi.org/reference/data-exchange/api-guidelines/design-and-implementation-guidelines/api-implementation-guidelines/handling-optimistic-concurrency-with-etags)
- [Database transactions, lost updates and idempotency (STRV)](https://www.strv.com/blog/database-transactions-lost-updates-idempotency-engineering)
- [Postgres full text search vs the rest (Supabase)](https://supabase.com/blog/postgres-full-text-search-vs-the-rest)
- [Meilisearch vs PostgreSQL (Meilisearch)](https://www.meilisearch.com/comparisons/meilisearch-vs-postgresql)
- [Using materialized views in ClickHouse vs Postgres (LaunchDarkly)](https://launchdarkly.com/docs/tutorials/clickhouse-materialized-views)
- [Postgres to ClickHouse (2026)](https://makmel.pages.dev/blog/2026-04-30-postgres-to-clickhouse)
- [Durable execution without a workflow engine (JobRunr)](https://www.jobrunr.io/en/blog/durable-execution-without-a-workflow-engine/)
- [Converting a job scheduling system to Temporal Schedules (Temporal)](https://temporal.io/blog/how-to-convert-your-job-scheduling-system-to-temporal-schedules)
- [MinIO archived: self-hosted S3 alternatives (Pinggy)](https://pinggy.io/blog/minio_archived_self_hosted_s3_alternatives/)
- [MinIO alternative: SeaweedFS (ITNEXT)](https://itnext.io/minio-alternative-seaweedfs-41fe42c3f7be)
- [Lago vs OpenMeter (OpenAlternative)](https://openalternative.co/compare/lago/vs/openmeter)
- [Splink: fast probabilistic data linkage at scale (PyPI)](https://pypi.org/project/splink/3.0.0)
- [Person linkage case study (IHME)](https://awesome.ecosyste.ms/projects/github.com%2Fihmeuw%2Fperson_linkage_case_study)
- [JWKS (Auth0)](https://auth0.com/docs/tokens/concepts/jwks)
- [Best practices for caching the Okta JWKS (Okta)](https://support.okta.com/help/s/article/best-practices-for-caching-the-okta-json-web-keys-set-jwks-for-oauth)
- [JWKS and key rotation for JWT validation (Gravitee)](https://gravitee.io/jwks-guide.html)
- [Zero-downtime PostgreSQL migrations: expand/contract (DEV)](https://dev.to/software_mvp-factory/zero-downtime-postgresql-schema-migrations-expandcontract-vs-blue-green-deployment-339o)
- [PostgreSQL migration best practices for zero downtime (DEV)](https://dev.to/mickelsamuel/postgresql-migration-best-practices-for-zero-downtime-deployments-1c4)
- [How to implement cache versioning in Redis (OneUptime)](https://oneuptime.com/blog/post/2026-03-31-redis-cache-versioning/view)
- [Muninn: tenant-scoped cache versioning](https://github.com/kaykym2411/muninn/wiki)
