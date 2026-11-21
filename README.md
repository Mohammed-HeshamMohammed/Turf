# Caller Whale

Caller Whale is a CRM for real-estate lead calling: the CRM app (desktop and browser), the public website, and the services
behind them. Everything lives in this one repository; the plan for its layout is
[09-repository-and-releases.md](docs/plans/people-teams-chats-clients/09-repository-and-releases.md).

## Layout

| Folder | What is in it |
| --- | --- |
| `apps/crm` | The CRM app (React). The same code runs in the desktop window and in the browser at app.callerwhale.com. |
| `apps/crm-desktop` | The desktop window around the CRM (Tauri). |
| `apps/crm-web` | How the CRM is packaged for app.callerwhale.com (its image). |
| `apps/website` | callerwhale.com. |
| `apps/lists-desktop` | The older desktop app for lists and areas; it has its own [README](apps/lists-desktop/README.md). |
| `services/` | The server side, one folder per service, each its own container: gateway, auth, authz, notifications, crm-core (with crm-merge and crm-outbox), messaging, live, dialer-sms, importing-lists, importing-worker, billing, assistant, learning, mcp, alert-relay, grafana-proxy. Auth, authz and notifications always stay one whole container each (D390). |
| `packages/` | Shared code with one original: `calendar`, `auth-client` and `error-report` (npm, `@callerwhale/*`), and `go/authverify` and `go/runtimelog` (Go). |
| `engines/skip-engine` | The Skip Tracing engine (Python), shipped inside the desktop app. |
| `crates/desktop-features` | The desktop app's feature crates (Rust). |
| `scaffolds/` | Services with no business logic yet. Never built into an image or deployed (D384). |
| `contracts/` | The API and event contracts between the parts. |
| `env/` | Example settings for every part. Real settings files stay here on your machine only; git ignores them. |
| `tools/` | Repository tools: CI parts, image builds and deploys, checks, generators. |
| `deploy/` | Deployment: `coolify-pull` (the server's deploy puller), `monitoring` (Grafana and friends), `compose` (local development), `k8s` (kept as history). |
| `docs/` | Plans, operations, legal, features, design notes, product notes, history and assets. |

## Working on it

- Install once at the root: `npm ci` (npm workspaces for `packages/*`, `apps/crm` and `apps/website`). The older desktop app
  installs on its own, from `apps/lists-desktop`.
- Rust: `cargo test --workspace` at the root (the desktop window and its crates). Each Go service is its own module in
  `services/<name>`; the Python services and the engine install from their own `requirements.txt`.
- Changes reach `main` by pull request; see [AGENTS.md](AGENTS.md).

## How it ships

1. A merge to `main` passes CI (the **CI summary** check).
2. The Images workflow builds each changed image and waits for the owner's approval in GitHub (the `production` environment).
3. After approval, the server's deploy puller (`deploy/coolify-pull`) applies it to Coolify on the server itself, so nothing
   has to pass Cloudflare's bot protection, which stays on.

The desktop app has its own release workflow (`.github/workflows/release-crm.yml`).
