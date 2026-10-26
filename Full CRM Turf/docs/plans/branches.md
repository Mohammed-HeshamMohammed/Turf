# Branches for Full CRM Turf

One local branch per part, all named `crm/<part>`, so each part can be worked on without touching the others. They are local only and nothing here is pushed. Turf (the other app) has no branches of its own.

| Branch | Part | Folder | State |
| --- | --- | --- | --- |
| `crm/landing-web` | Landing site frontend | `landing/web/` | Has its own commits (site, pricing builder) |
| `crm/landing-api` | Landing site backend | `landing/api/` | Has its own commits (waitlist, stats, static serving) |
| `crm/stack-scaffold` | The scaffold itself: folders, templates, tools, compose, contracts | `services/`, `desktop/`, `deploy/`, `contracts/`, `tools/` | Base of every branch below |
| `crm/desktop-container` | Tauri shell | `desktop/container/rust/` | At the scaffold |
| `crm/desktop-frontend` | React screens | `desktop/frontend/react/` | At the scaffold |
| `crm/desktop-backend` | Rust modules, one per feature | `desktop/backend/` | At the scaffold |
| `crm/server-backend` | The existing server code (`backend/`) as it moves into services | `backend/` | At the scaffold |
| `crm/service-gateway` | Gateway | `services/gateway/` | At the scaffold |
| `crm/service-auth` | Authentication | `services/auth/` | At the scaffold |
| `crm/service-notifications` | Notifications | `services/notifications/` | At the scaffold |
| `crm/service-billing` | Billing | `services/billing/` | At the scaffold |
| `crm/feature-importing-lists` | Feature 1 (server) | `services/features/importing-lists/` | At the scaffold |
| `crm/feature-skip-tracing` | Feature 2 (server) | `services/features/skip-tracing/` | At the scaffold |
| `crm/feature-dialer-sms` | Feature 3 (server) | `services/features/dialer-sms/` | At the scaffold |
| `crm/feature-leads-map` | Feature 4 (server) | `services/features/leads-map/` | At the scaffold |
| `crm/feature-crm` | Feature 5 (server) | `services/features/crm/` | At the scaffold |
| `crm/feature-ai-campaigns` | Feature 6 (server) | `services/features/ai-campaigns/` | At the scaffold |
| `crm/feature-exports` | Feature 7 (server) | `services/features/exports/` | At the scaffold |
| `crm/feature-backup-restore` | Feature 8 (server) | `services/features/backup-restore/` | At the scaffold |
| `crm/release-pipeline` | Desktop release workflow (Phase 2) | `.github/workflows/` | At the scaffold |
| `crm/contracts` | API and event definitions | `contracts/` | At the scaffold |

## How to work

- Work on a part in its own branch and keep to its folder. A change that crosses parts (a new event, a new API call) goes in `crm/contracts` first.
- Desktop modules (`desktop/backend/features/<name>/`) belong to `crm/desktop-backend`, not to the feature's server branch.
- Merge into `magdy` one part at a time, tests passing (`node tools/check-stack.mjs`).
- Adding a service: add it to `tools/stack.json`, run `node tools/scaffold-stack.mjs`, then give it a branch.
