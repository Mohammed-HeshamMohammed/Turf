# Turf: Full CRM, Offline Work, and Backend Performance Plan

**Date:** 15 October 2026

**Status:** Complete implementation plan. Implementation is pending.

**Historical context:** Preserve the existing `PLAN.md` as the record of Turf's original scope.

## 1. Goals and agreed scope

Build Turf into a property-focused CRM for solo operators, researchers, callers, closers, managers, business owners, administrators, and external clients.

The completed application will provide:

- Shared leads, properties, contacts, lists, deals, tasks, communication, and documents.
- Personal and team workspaces, assignment, permissions, collaboration, and reporting.
- Email, SMS, integrated voice calling, recordings, and delivery tracking.
- Offline viewing and queued CRM changes, with explicit synchronization and conflict handling.
- A local Skip Tracing backend that works without the VPS.
- Concurrent requests and compiled matching across CPU cores.
- Separate backend folders and container definitions for Rust, Python, Go, C, C++, and JavaScript.
- A self-hostable VPS deployment, with reproducible builds and operational documentation.

**Runtime boundary:** CRM authority remains on the VPS. Offline CRM work lives in the client's encrypted cache and operation queue. Only Skip Tracing runs a local backend; its compiled libraries are part of that backend.

**Product boundary:** Extend the CRM workflows reviewed in EspoCRM. Accounting, inventory, subscription billing, and a general-purpose ERP remain outside this plan.

Current Turf already supplies lists, imports, matching, phone evidence, duplicate review, calling outcomes, history, callbacks, a board, bulk changes, search, filters, exports, and backups. Preserve those capabilities while replacing their single-user assumptions.

## 2. Architecture, contracts, and data flow

### 2.1 Repository and language responsibilities

Keep the React/TypeScript application and Tauri desktop host in their existing locations. Organize new backend source as follows:

```text
backend/
  rust/          Core API, authorization, database access, native grouping
  python/        Skip Tracing, normalization, enrichment, ML, import/export
  go/            Scheduling, workflow execution, cache invalidation, notifications
  c/             Audio/media processing using FFmpeg libraries
  cpp/           Batch evidence comparisons and matching computation
  javascript/    Email, SMS, voice, and external provider adapters
contracts/       API schemas, events, worker contracts, native ABI definitions
deploy/          Docker Compose, proxy configuration, operational scripts
docs/            Architecture, migrations, administration, troubleshooting
```

Each language folder receives its own dependency locks, tests, build commands, README, health checks, and Dockerfile. Container builds use the repository root as context when they need shared contracts.

| Language | Responsibility | Deployment |
| --- | --- | --- |
| **Rust** | Public API, authentication, permission enforcement, authoritative transactions, synchronization, WebSocket events, deterministic grouping. | VPS API container; shared grouping library bundled into offline Skip Tracing. |
| **Python** | Existing phone and normalization rules, enrichment, status models, import/export, Skip Tracing coordination, transcription. | VPS worker container and packaged local Skip Tracing executable. |
| **Go** | Scheduled tasks, workflow processing, job dispatch, notification fan-out, projection rebuilding, cache invalidation. | Private VPS worker container. |
| **C++** | Batched comparison of normalized candidates, evidence generation, scores, and matching decisions. | Private VPS worker container and offline native library. |
| **C** | Recording conversion, audio normalization, waveform generation, and playback derivatives using maintained FFmpeg libraries. | Private VPS media worker container. |
| **JavaScript** | Provider SDKs, email synchronization, SMS, voice integrations, webhook verification, delivery reconciliation. Backend source uses `.js`. | Private VPS integration container. |

Use existing libraries for codecs, string metrics, cryptography, and provider protocols. Custom code should coordinate those libraries and implement Turf's domain rules.

Additional languages are not required for the initial architecture.

### 2.2 Server infrastructure and ownership

Use:

- **Rust Axum/Tokio** for the API and concurrent request handling.
- **PostgreSQL** for canonical CRM records, job state, synchronization history, and audit events.
- **Redis** as the main shared cache and notification/wakeup mechanism.
- **Content-addressed filesystem storage** on a persistent VPS volume for imports, attachments, recordings, and generated artifacts.
- **Caddy** for HTTPS, frontend delivery, and reverse proxying.
- **Docker Compose** for the first self-hosted deployment.

Rust owns authoritative database migrations and CRM mutations. Workers obtain scoped jobs and publish results through internal API contracts. They do not independently change lead ownership, permissions, or canonical business records.

PostgreSQL holds durable jobs and transactional outbox events. Redis can be emptied or restarted without losing edits, jobs, or completed communication records.

Only the proxy exposes public application ports. Databases and worker endpoints stay on private container networks.

### 2.3 Application and worker interfaces

Preserve the existing frontend service exports while introducing transport selection behind them:

- Online CRM requests use the VPS API.
- Local Skip Tracing requests use the Tauri-managed sidecar.
- Offline CRM mutations enter the client operation queue.

Define versioned contracts under `contracts/`:

| Interface | Required behavior |
| --- | --- |
| Public `/api/v1` | Authentication, workspace selection, scoped queries, pagination, record versions, consistent errors. |
| `/sync/push` | Submit uniquely identified operations; return applied, duplicate, rejected, or conflicting results individually. |
| `/sync/pull` | Return authorized changes and tombstones after a workspace cursor, including access-removal instructions. |
| `/events` | WebSocket notifications for record changes, job progress, reminders, communication, and invalidation. |
| Internal job API | Claim/renew leases, retrieve scoped inputs, report progress, cancel, complete, or fail. |
| Native matching ABI | Versioned input/output buffers, explicit memory ownership, cancellation, bounded batches, and stable errors. |

All mutation requests carry an operation ID. Version-sensitive mutations also carry the version the client edited. The server derives identity and effective permissions from the authenticated session.

Internal worker requests carry a job identity and narrowly scoped authorization. JSON carries control information; MessagePack carries large normalized comparison batches.

Use bounded requests and streamed artifact transfers. Large files and datasets must not pass through repeated base64 JSON envelopes.

### 2.4 Identity and permissions

Provide invitation-based accounts, email/password authentication, established Argon2id and TOTP libraries, session revocation, and recovery codes. Require MFA for owners and system administrators.

Browser sessions use secure HttpOnly cookies. Desktop credentials use OS-backed secure storage. Provider credentials remain encrypted on the server.

Model authorization as **capabilities plus record scope**, with configurable role presets:

- Own assigned records.
- Managed team records.
- Selected project records.
- Authorized organization records.
- Explicitly shared external records.

Enforce access on reads, searches, dashboard counts, exports, bulk changes, jobs, attachments, recordings, synchronization, and notifications.

Use PostgreSQL row security for organization isolation and application checks for team, assignment, sharing, and field permissions. The runtime database role must not bypass row security. [PostgreSQL documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

Role changes increment an access revision, invalidate affected caches, revoke sessions where appropriate, and remove unauthorized offline records on the next connection.

### 2.5 Core data model

Introduce stable identifiers for:

- Organizations, users, memberships, teams, roles, and grants.
- Projects, datasets, source rows, and immutable dataset versions.
- People/organizations, properties, ownership relationships, leads, and deals.
- Assignments, handoffs, tasks, appointments, notes, and activity events.
- Conversations, messages, call sessions, recordings, attachments, and templates.
- Jobs, workflow definitions, notifications, synchronization operations, and outbox events.

Separate identity carefully:

- One owner may own several properties.
- One property may have changing ownership.
- A lead represents an outreach relationship.
- A deal represents a specific transaction.
- The same lead may appear in several source lists.

Preserve legacy lead keys as aliases during migration. Keep original source rows and provenance immutable.

Mutable records receive versions. Audit events capture actor, server time, relevant before/after values, and originating operation. Offline events retain their claimed occurrence time separately from the server's receipt time.

Store timestamps in UTC, with IANA timezones for users and scheduled activities. Financial amounts use decimal values and an explicit currency; imported listing prices never become revenue automatically.

### 2.6 Multilayer caching

Rust owns the cache policy and permission checks. Go processes committed events to invalidate or rebuild derived caches.

| Layer | Purpose |
| --- | --- |
| Client memory | Immediate rendering, request deduplication, active records, bounded query results. |
| Client IndexedDB | Encrypted cached records, pinned offline datasets, drafts, and unsynchronized operations. |
| Service memory | Small bounded caches for immutable inputs and inexpensive hot metadata. |
| **Redis** | Main shared cache for scoped query results, dashboards, metadata, and projections. |
| PostgreSQL projections | Durable indexes and summaries that can be rebuilt from canonical records. |
| Artifact storage | Immutable files and derived media addressed by content hash. |

Use keys containing organization, project, access revision, data revision, and query parameters where relevant.

Data-specific defaults:

- **Permissions and outbound eligibility:** authoritative checks on every online action.
- **Mutable CRM records:** versioned cache, live invalidation, 30-second revalidation window.
- **Dashboard summaries:** 30-second cache, with visible refresh state.
- **Immutable source batches:** content hash and dataset version; retain while authorized and pinned.
- **Reference/enrichment results:** existing provider-specific expiry and evidence timestamps.
- **Files/media:** content hash, authenticated retrieval, short-lived download authorization.
- **Pending operations:** durable until synchronized, explicitly discarded, or resolved; never evicted as ordinary cache.

Redis failure falls back to authorized database queries. Cache invalidation failure must not allow stale permissions or stale do-not-call state to authorize communication.

Bound client storage initially to 500 MB, excluding explicitly approved larger Skip Tracing bundles. Evict least-recently-used synchronized data first. Preserve pending edits and disclose quota failures.

### 2.7 Offline edits and synchronization

Use IndexedDB through Dexie for durable client queues and transactions. Dexie provides the local storage layer; Turf implements its own synchronization protocol. [Dexie documentation](https://dexie.org/docs/Dexie.js)

The client displays:

- Server-confirmed state.
- Cached state and its age.
- Pending local changes.
- Conflicting or rejected operations.

Allow offline notes, manual call logs, callbacks, lead-stage changes, task updates, communication drafts, and pending attachments.

Permission changes, integrations, destructive bulk actions, and external communication execution require an online server.

Synchronization sequence:

1. Authenticate and refresh permissions.
2. Refresh safety-critical contact and suppression information.
3. Upload pending attachments.
4. Submit queued operations in dependency order.
5. Pull committed changes and access-removal events.
6. Refresh affected records, counts, and caches.

Conflict rules:

- Append-only notes and manual call events use operation IDs for deduplication.
- Versioned field edits apply when the edited fields remain unchanged.
- Conflicting field values enter a review screen with local/server values.
- Deleted records or removed access reject pending mutations without recreating the record.
- Client clocks do not determine which edit wins.
- Multiple tabs/devices must not duplicate submissions.

Offline outreach remains a draft until reviewed online. Starting a call is an interactive online action. Approved server schedules continue on the VPS.

Cache contents are encrypted. Desktop keys use OS storage; browser offline data requires an unlock passphrase. Offline access leases expire after 24 hours and require online renewal. Local revocation cannot be instantaneous on a disconnected device; submissions are reauthorized on reconnect.

### 2.8 Local Skip Tracing

Provide a desktop-only local backend with:

- Local file import and column mapping.
- Phone checks and duplicate comparisons.
- Imported call outcomes, reference evidence, and manual review constraints.
- Progress, cancellation, checked-copy export, and local job recovery.
- Optional models already downloaded before disconnecting.

The browser application uses server Skip Tracing and directs users to the desktop application for offline execution.

A downloaded Skip Tracing bundle includes only authorized source data, mappings, relevant evidence, policy versions, hashes, and the source revision.

Local results are explicitly marked local. Publishing them online requires fresh authorization and source/evidence validation. Changed evidence makes the result stale and requires rerunning affected checks.

The local command router exposes Skip Tracing functions only. CRM authority and user administration do not remain accessible through the old full-service sidecar.

### 2.9 Concurrent requests and native matching

Remove request serialization across the desktop bridge, Python dispatcher, and development bridge:

- Route responses through a pending-request map keyed by request ID.
- Allow replies to complete out of order.
- Separate lifecycle locks from response waiting.
- Use per-worker database connections.
- Bound read concurrency and serialize local SQLite writes.
- Drain or cancel active requests safely when changing the local workspace or restarting the service.

For matching:

1. Keep Python normalization and phone interpretation as the reference.
2. Construct candidates across the entire input.
3. Send normalized candidates to C++ in bounded batches.
4. Evaluate independent comparisons across CPU cores.
5. Assemble global groups centrally using shared Rust grouping code.
6. Retain Python likelihood estimation initially, using native batch comparisons where applicable.

Preserve household guards, property separation, shared-number suppression, manual constraints, deterministic ordering, evidence explanations, and survivor selection.

RapidFuzz already performs much of its work in C++; the improvement must come from batching and reducing orchestration overhead. [RapidFuzz source documentation](https://github.com/rapidfuzz/RapidFuzz)

Use a global CPU budget that respects container limits. Default to leaving two server cores available for API work and one desktop core for responsiveness. Small inputs stay on the reference path when native startup costs outweigh computation.

Enable the native engine by default only after correctness parity and at least 20% end-to-end improvement on the large-list benchmark. A failed gate keeps the reference implementation active.

## 3. Product workflows and role experiences

### 3.1 Role presets

| Role | Default experience and capabilities |
| --- | --- |
| Solo operator | One-person organization with research, calling, closing, and reporting capabilities. |
| Researcher / data operator | Assigned lists, imports, mapping, evidence checks, duplicate review, publishing and permitted exports. |
| Caller | Assigned queue, contact context, scripts, outcomes, callbacks, qualification, and handoff. |
| Acquisitions / closer | Qualified leads, appointments, offers, negotiation, documents, deal stages, and next actions. |
| Team lead / manager | Team assignment, workload, handoffs, exceptions, coaching, and team reporting. |
| Business owner | Organization reporting, business policy, pipeline configuration, and authorized financial information. |
| System administrator | Identity, permissions, integrations, backups, diagnostics, and operational configuration. Confidential business access is a separate grant. |
| Client / partner | Explicitly shared records, approved updates, deliverables, permitted comments, and uploads. |

People may hold multiple roles. Explicit restrictions override combined grants. System administration alone does not grant unrestricted customer-record access.

### 3.2 Navigation and record pages

Retain Turf's existing visual language and custom desktop chrome.

Introduce routed main-pane pages with primary destinations:

- Dashboard.
- Work.
- Lists.
- Skip Tracing.
- Reports.

Work contains Leads, Calls, Deals, Tasks, Calendar, and Inbox. Settings and Administration remain separate destinations with permission-based visibility.

Use full pages for substantial creation/editing flows and compact panels for previews and quick actions. Preserve navigation state, selections, filters, and unsaved drafts.

The lead page connects property, owner, source lists, phone evidence, assignment, communication, notes, tasks, documents, and deals. Surface the next action and contact restrictions near the communication controls.

### 3.3 Assignment, qualification, and handoff

Every active lead has an owner, team, stage, next action, and optional due time.

Provide:

- Individual and bulk assignment.
- Unassigned queues.
- Round-robin and workload-aware assignment rules.
- Assignment history and reassignment reasons.
- Qualification templates by project.
- Handoff states: requested, accepted, declined, cancelled, overdue.

A caller supplies required qualification details and requests a handoff. The recipient accepts responsibility; ownership, history, and related tasks update transactionally.

Use the existing lead stages as the initial preset. Add a separate deal pipeline:

**Qualified → Appointment → Offer preparation → Offer sent → Negotiation → Under contract → Closed won / Closed lost**

Owners can configure stage labels, required fields, and outcome reasons. Deal changes preserve the linked lead and property history.

### 3.4 Tasks, dashboards, and collaboration

Tasks support type, priority, assignee, due time, timezone, completion, recurrence, and related records.

Callbacks become linked task instances while retaining compatibility with existing callback data.

Role-specific dashboards provide:

- Callers: leads to work, due callbacks, overdue tasks, personal outcomes.
- Researchers: unreviewed imports, stale checks, data quality, failed jobs.
- Closers: accepted handoffs, appointments, offers, aging deals.
- Managers: unassigned work, pending handoffs, workload, overdue actions, conversions.
- Owners: pipeline, source effectiveness, deal outcomes, and financial totals.

Every metric opens its underlying authorized records.

Add internal comments, mentions, followers, notifications, team activity, shared files, and conversation threads. External-visible updates have explicit visibility and publishing controls.

### 3.5 Communication suite

Use Node-based adapters with initial providers:

- SMTP/IMAP for general email accounts.
- Google and Microsoft OAuth adapters for their mail services.
- Twilio for SMS and voice.
- Provider-neutral interfaces so additional services can be added without changing CRM records.

Email includes inbound synchronization, threading, attachments, drafts, templates, scheduled sends, retries, and bounce/error tracking.

SMS includes inbound replies, templates, scheduling, delivery states, suppression/opt-out handling, and approved campaign batches.

Voice includes inbound/outbound calls, queues, agent availability, hold, transfer, voicemail, disposition, permitted recording, and associated tasks.

Use browser WebRTC calling for the web application. The Tauri application uses an authenticated browser companion for softphone audio and mirrors call controls/status. Preserve existing click-to-dial. Twilio documents supported browsers and Electron; Tauri WebView compatibility must not be assumed. [Twilio Voice SDK documentation](https://www.twilio.com/docs/voice/sdks/javascript)

C media workers create playback derivatives and waveforms while preserving original recordings. Python provides server transcription using a provisioned Whisper model. Transcripts and suggested summaries require review before becoming business notes.

Verify provider webhook signatures, deduplicate events, reconcile uncertain delivery, and recheck authorization and current suppression information before execution. Never blindly retry a send whose provider acceptance is unknown.

Provider credentials and funded test accounts are deployment inputs. Features show "not configured" until connected.

### 3.6 Automation, configuration, reports, and external access

Implement a bounded rules engine with:

- Triggers: import published, lead qualified, handoff requested, stage changed, task overdue, message/call outcome received.
- Conditions: fields, source list, team, stage, elapsed time, communication outcome.
- Actions: create task, assign, notify, request handoff, move stage, execute an approved communication template.

Rules are versioned, auditable, and idempotent. Add loop prevention, retry limits, dry runs, and execution history.

Provide configurable qualification fields, scripts, templates, pipeline settings, and role layouts. Version configuration changes and validate queued operations against current requirements.

Reports include contact rate, qualification rate, accepted handoffs, missed follow-ups, source performance, stage aging, outcomes, and recorded revenue. Support saved reports, scheduled delivery, CSV, and PDF output.

The external workspace exposes explicitly shared records and approved updates. Internal notes, unrelated source lists, recordings, and financial fields remain separately permissioned.

## 4. Delivery milestones

| Milestone | Work | Exit criteria |
| --- | --- | --- |
| **0 — Plan and baseline** | Save this Markdown plan, preserve historical `PLAN.md`, document current behavior, create representative datasets and performance baselines. | Plan committed; baseline results recorded without presenting historical timings as current measurements. |
| **1 — Service boundaries** | Create six language folders, contracts, builds, containers, Rust API, PostgreSQL, Redis, artifact storage, and deployment skeleton. | Independently buildable containers; authenticated internal communication; CI contract checks. |
| **2 — Identity and migration** | Implement accounts, roles, organizations, teams, stable entities, audit, and legacy project import. | Existing data migrates with preserved history and source lineage; isolation tests pass. |
| **3 — CRM workflows** | Lead pages, assignment, handoffs, deals, tasks, calendar, collaboration, dashboards. | Caller-to-closer workflow completes with correct ownership and visible history. |
| **4 — Offline and caching** | Encrypted caches, pending edits, synchronization, conflict review, scoped invalidation, local Skip Tracing bundles. | Disconnect/restart/reconnect preserves work; rejected edits remain visible; caches do not leak records. |
| **5 — Performance** | Concurrent transport, C++ comparisons, Rust grouping, resource budgets, large-list optimization. | Correctness parity and performance gates pass; slow jobs do not block quick reads. |
| **6 — Communication** | Email, SMS, voice, recordings, transcription, inbox, campaigns, provider reconciliation. | Controlled live provider tests pass separately from mocked integration tests. |
| **7 — Automation and reporting** | Rules, configurable fields/templates, scheduled reports, external workspace. | Rules execute idempotently; reports respect scope; external users see only approved information. |
| **8 — Production readiness** | Package Windows application, complete VPS deployment tooling, backups, recovery, observability, operational documentation. | Fresh-machine installation and staging recovery tests pass; release evidence is recorded. |

Use feature flags and reversible migrations while developing these milestones. Savepoint-based legacy imports remain hidden until validation completes.

Legacy import must preserve notes, callbacks, manual marks, call evidence, matching overrides, datasets, and artifact hashes. Unknown historical actors are labelled "Legacy import"; unowned leads enter an unassigned queue.

Keep original project folders unchanged during import. Afterwards, local project opening becomes a Skip Tracing workspace; CRM data is accessed through the server.

## 5. Testing, performance, packaging, and release

### 5.1 Required tests

Extend the existing frontend, Python, and Rust checks with Go, JavaScript, C, C++, PostgreSQL, Redis, synchronization, and container tests.

Cover:

- Every role, action scope, field restriction, export, search, dashboard, attachment, and background job.
- Cross-organization and cross-team isolation, including direct API requests.
- Role revocation, logout, expired offline access, and cache removal.
- Concurrent edits, overlapping assignments, duplicate handoff acceptance, and replayed operations.
- Offline restart, storage quota exhaustion, multi-tab submission, clock skew, lost responses, deleted records, and conflicts.
- Redis outage, worker crash, lease expiry, duplicate events, and partial artifact uploads.
- Provider webhook verification, event duplication, uncertain sends, rate limiting, and expired tokens.
- End-to-end email/SMS/voice behavior using controlled recipients and accounts.
- Native cancellation, malformed buffers, memory safety, and cross-platform matching parity.

Matching fixtures must cover different household members, multiple properties per owner, reordered names, Unicode, shared office numbers, contradictory identifiers, units, manual constraints, and bridge rejection.

Use real PostgreSQL queries and migrations; mocked storage does not establish SQL correctness.

### 5.2 Performance targets

Use an initial staging reference of **8 vCPU, 16 GB RAM, SSD storage**, with 10 active users and representative 60,000-row, 200,000-row, and one-million-row datasets.

Release targets:

- Warm ordinary reads: p95 below 500 ms under background job load.
- Warm dashboard summaries: p95 below one second.
- Cached navigation: useful content visible within 200 ms.
- Native matching: at least 20% end-to-end improvement on the large-list baseline.
- Bounded memory during large imports and comparisons.
- No duplicate publication after retries, crashes, or reconnection.

Record cold/warm performance, single-core/multicore performance, memory, serialization time, provider delay, clean builds, and incremental builds separately.

These are acceptance targets, not claims about current performance.

### 5.3 Build and compile efficiency

Use incremental builds and language-specific caches:

- Rust Cargo cache and `sccache`; thin LTO for release builds only.
- C/C++ CMake and Ninja, compiler caching, prebuilt pinned dependencies.
- Go module/build cache.
- Node lockfiles and dependency-layer caching.
- Python wheels and prebuilt native artifacts.

Build only affected components on ordinary changes. Run full integration and packaging checks for release candidates.

Produce Linux worker images and Windows native libraries from the same contract and policy versions. Package offline Skip Tracing so users do not need Python, compilers, Go, or Docker.

Go, CMake, Ninja, and C/C++ compilers were not available on the current shell path during exploration; implementation setup must verify or provision those tools.

### 5.4 Operations and recovery

Provide:

- Correlated request/job/operation IDs across services.
- Metrics for API latency, cache hit rate, queue delay, synchronization failures, conflicts, worker utilization, and communication delivery.
- Logs without credentials or unnecessary contact values.
- Container resource limits, health/readiness checks, and graceful shutdown.
- Daily encrypted database/artifact backups and a tested restore procedure.
- Deployment preflight, migration checks, rollback instructions, and schema compatibility checks.

Windows acceptance must use the real packaged Tauri application. Verify offline Skip Tracing, queue durability, secure storage, notifications, browser-companion calling, and reconnect behavior on a clean machine.

### 5.5 Completion and repository workflow

A capability is complete only when its behavior, authorization, failure handling, tests, and documentation are finished. Distinguish mocked checks, live provider checks, packaged desktop checks, and deployed-server checks.

This document is the planning artifact; saving it does not implement the milestones. Verify document paths and decisions, then commit it to `main` and push to `origin/main`, following the standing repository instruction.

For implementation milestones, run the applicable checks, preserve unrelated changes, commit verified work to `main`, push, and inspect CI results. Providing deployment tooling does not itself establish that the VPS is deployed.

**Defaults selected:** VPS-hosted solo and team CRM; local backend only for Skip Tracing; queued offline CRM edits; PostgreSQL authority; Redis as the main shared cache; all six requested languages with explicit responsibilities; existing Tauri/React clients; property-focused workflows; no subscription-billing platform.
