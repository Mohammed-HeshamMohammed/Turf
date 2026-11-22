# Service registry

Every container that runs on the server, with its private address (network alias and port on Coolify's `coolify` network). The
gateway is the only public entry; it routes each host in its `ROUTES` setting to one of these and checks sign-in tokens with the
auth service's public keys. Each Go and Python service's folder is `services/<name>` unless noted.

| Container | Port | Language | Folder | What it does |
| --- | --- | --- | --- | --- |
| gateway | 8100 | Go | `services/gateway` | The one public entry: routes hosts, checks tokens, limits rates, shields auth |
| auth | 8101 | Go | `services/auth` | Sign-in, sessions, second factor, workspaces, the status page |
| notifications | 8102 | Go | `services/notifications` | Every email Caller Whale sends; queue and retries in its own database |
| billing | 8103 | Python | `services/billing` | Plans, payments, budgets (parked) |
| authz | 8104 | Go | `services/authz` | Who may do what; signs the grants other services check |
| mcp | 8106 | Go | `services/mcp` | Lets AI assistants (Claude, ChatGPT, Gemini) use the CRM |
| crm-core | 8107 | Go | `services/crm-core` | The CRM API: leads, tasks, imports into the CRM, the `/events` socket |
| crm-merge | 8120 | Go | `services/crm-core` (`cmd/crm-merge`) | crm-core's merge, assignment and upkeep job queues |
| crm-outbox | 8121 | Go | `services/crm-core` (`cmd/crm-outbox`) | crm-core's outbox: webhooks, email waits, reports, file scans |
| messaging | 8108 | Go | `services/messaging` | Team chats, groups, announcements |
| centrifugo | 8000 | Centrifugo | `services/live` | The live server: holds the apps' sockets, reads messaging's outbox |
| assistant | 8109 | Go | `services/assistant` | The in-app assistant |
| importing-lists | 8111 | Python | `services/importing-lists` | Takes lead list uploads |
| importing-worker | 8119 | Python | `services/importing-worker` | Reads, cleans and imports the uploaded lists |
| learning | 8112 | Go | `services/learning` | Learning store: hashes and shapes of imported data |
| dialer-sms | 8113 | Go | `services/telnyx` (`cmd/dialer-sms`) | Calls and texts through Telnyx, every part in one, until the six below take over |
| telnyx-phone-api | 8113 | Go | `services/telnyx` | The browser's calls, numbers, hours, status, budgets |
| telnyx-phone-webhooks | 8122 | Go | `services/telnyx` | Telnyx call webhooks |
| telnyx-phone-jobs | 8123 | Go | `services/telnyx` | Settling calls into the CRM, callbacks, erasures |
| telnyx-sms-api | 8124 | Go | `services/telnyx` | The browser's texts |
| telnyx-sms-webhooks | 8125 | Go | `services/telnyx` | Telnyx text and 10DLC webhooks |
| telnyx-sms-jobs | 8126 | Go | `services/telnyx` | Scheduled texts, unanswered texts, 10DLC, standing |

The monitoring stack (`deploy/monitoring`, one Coolify compose resource) runs Grafana, Prometheus, Loki, Alloy, the blackbox
prober, `grafana-proxy` (Go, its login gate) and `alert-relay` (Go, 8121 on the monitoring network: phone alerts and `/probes`).

Each service's settings are in `env/<name>.production.example`; its API, where it has one, in its folder's `openapi.yaml`.

## Scaffolds (not deployed)

`scaffolds/` holds services with no business logic yet; they are never built into an image (D384): ai-campaigns, backup-restore,
crm, exports, leads-map, skip-tracing.
