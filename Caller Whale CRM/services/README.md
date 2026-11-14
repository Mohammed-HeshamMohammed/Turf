# Services

The server side of Caller Whale CRM: one folder per service, each with its own code, tests, `openapi.yaml`, `Dockerfile` and (when it owns data) `database_setup/`. See [the plan](../docs/plans/service-architecture.md) for why, and [the registry](../contracts/services.md) for ports and events.

| Service | Folder | Language | Port | Owns data | Job |
| --- | --- | --- | --- | --- | --- |
| gateway | `services/gateway/` | Go 1.23 or newer | 8100 | no | The one public entry point: HTTPS, token check, rate limits, and routing of /api/v1/<service>/* to the service behind it. |
| auth | `services/auth/` | Rust | 8101 | yes | Accounts, sessions, two-step sign-in, Google sign-in, roles and tokens. Signs short-lived tokens and publishes its public keys. Nothing else. |
| notifications | `services/notifications/` | Go 1.23 or newer | 8102 | yes | Email, SMS, push and in-app notifications, sent when another service publishes notification.requested. Nothing else. |
| billing | `services/billing/` | Python 3.13 (FastAPI) | 8103 | yes | Plans, subscriptions, payments, call minutes and desktop credits. Records what the payment provider's signed webhooks say; money never moves through it. |
| authz | `services/authz/` | Go | 8104 | yes (PostgreSQL) | Decides what each person may do in each workspace and which database rights each request runs under. No public address. |
| importing-lists | `services/features/importing-lists/` | Python 3.13 or newer (polars) | 8111 | yes | Feature 1: the import worker. Loads uploaded lists into the CRM database, drops identical rows, matches columns, cleans data and finds repeats; crm-core merges the result into leads. |
| skip-tracing | `services/features/skip-tracing/` | Python 3.13 or newer | 8112 | yes | Feature 2: server-side phone checks, Do Not Call, number lookups and network hints. Shares its rules with the shared service/ engine. |
| dialer-sms | `services/features/dialer-sms/` | TypeScript | 8113 | yes | Feature 3: calling, auto dialing, texting, number health, call logs and the carrier webhooks. |
| leads-map | `services/features/leads-map/` | Rust | 8114 | yes | Feature 4: exact locations, reverse lookups and nearby search for leads. |
| crm-core | `services/crm-core/` | Go | 8107 | yes (PostgreSQL) | The CRM's backend (replaces the Rust `crm` row below): leads, tasks, notes, calls, deals, handoffs, sync and the live-updates socket, and list uploads. `gate.callerwhale.com` points here. |
| messaging | `services/messaging/` | Go | 8108 | yes (PostgreSQL) | Conversations between the people of a workspace: direct chats and groups, with replies, reactions, polls and unread counts. Later, text threads with leads. Delivers live through Centrifugo. |
| crm | `services/features/crm/` | Rust (to be folded into crm-core) | 8115 | yes | Feature 5: leads, deals, tasks, handoffs, roles and reports. Owns offline sync for records the desktop edits. |
| ai-campaigns | `services/features/ai-campaigns/` | TypeScript | 8116 | yes | Feature 6: email and text campaigns, AI writing, reply sorting and sending limits. |
| exports | `services/features/exports/` | Python 3.13 or newer | 8117 | yes | Feature 7: call lists, mail lists, whole-workspace exports and report files. |
| backup-restore | `services/features/backup-restore/` | Rust | 8118 | yes | Feature 8: the recycle bin, point-in-time restore and workspace downloads. |

**`auth/` is built**: the one source of truth for who someone is (accounts, two-step sign-in, sessions, signed tokens and the public keys every service checks them with). The other new services are scaffolds: each starts, answers `/healthz` and `/version`, and has tests. The old Rust core API (and its Go and Python workers and the website it served) was removed; it lives in git history, and the CRM server is to be rebuilt in Go.

## Add a service

1. Add it to `tools/stack.json`.
2. Run `node tools/scaffold-stack.mjs` (it never overwrites existing files).
3. Run `node tools/check-stack.mjs`.

## The rules

1. A service owns its data: its own schema and login. No other service touches it.
2. Services talk through the gateway or events, never through each other's tables.
3. Auth is verified from public keys, not called on every request.
4. A service asks for a notification by publishing `notification.requested`. It never contacts Twilio, a mail server or a push service itself.
