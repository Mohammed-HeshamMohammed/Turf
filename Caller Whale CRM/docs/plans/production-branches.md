# Production branches

One branch per part of Caller Whale, each holding **only that part's code**, so a part can be deployed, handed over or reviewed on its own. They are named `<part>-production`:

| Branch | What it holds |
| --- | --- |
| `landing-web-production` | The website (`apps/website`), in the repository layout with the npm workspace (root `package.json`, its lock file and `packages/`, step 49) |
| `landing-dashboard-web-production` | The CRM web app: the desktop frontend built for the browser, packaged by `apps/crm-web`, in the repository layout with the npm workspace (step 49) |
| `auth-backend-production` | The authentication service (`services/auth`) |
| `notifications-backend-production` | The notification service (`services/notifications`, Go) at the branch root |
| `gateway-backend-production` | The gateway: the one public entry point (it only answers its health check so far) |
| `messaging-backend-production` | The messaging service (`services/messaging`, Go) at the branch root: team chats and groups. No domain of its own |
| `dialer-sms-backend-production` | The dialer (`services/features/dialer-sms`, Go) at the branch root: Telnyx calls and texts, with a built-in Telnyx simulator (`TELNYX_MODE=simulate`). No domain of its own |
| `authz-backend-production` | The authorization service (`services/authz`, Go) at the branch root: decides what each person may do and which database rights each request gets. No domain |
| `billing-backend-production` | The billing service (`services/billing`, Python) at the branch root. No domain; the gateway routes its public paths |
| `desktop-app-production` | The whole desktop app: the frontend (`apps/crm`, also the CRM in a browser), the window container (Tauri) and the feature modules (`desktop/backend`) |
| `grafana-production` | Grafana for Caller Whale's staff and its login proxy (`deploy/grafana`, `services/grafana-proxy`), deployed on Coolify as one Docker Compose resource |
| `skip-engine-production` | The Skip Tracing engine (`service/`, Python) that the desktop app runs |

A part gets a branch when it runs as its own container on the VPS. The billing service and the eight server-side feature services are scaffolds that are not deployed yet, so they have none; the compose file and the original `Caller Whale App/` app have none either. When one needs its own, add it to `tools/production.json` and run the script.

Each server branch also carries its container file and its Kubernetes files (`infra/k8s/<part>/`): see `docs/plans/scaling-and-deployment.md`.

## What is in a branch

- By default, the part's folders keep their paths relative to `Caller Whale CRM/` on `main`. A component can set `base` and `paths: ["."]` to export that source folder directly to its branch root. The frontend, auth and gateway branches do this; other components retain their existing paths.
- The website, CRM web app and desktop branches (`base: ""`) keep the repository layout and carry the npm workspace: the root `package.json`, `package-lock.json`, `.npmrc`, `packages/` and the other web app's `package.json` (npm checks the lock file against every workspace). Their Dockerfiles build with the branch root as the context (step 49, D383). Landing Kubernetes manifests and the environment example remain on `main`; configure the landing build/runtime variables using `landing/web/COOLIFY.md`.
- For a Rust service: the Cargo workspace file cut down to the members present, and `Cargo.lock`. Dockerfile lines that copy a folder the branch does not have are removed.
- A generated `readme.md`: what it is, which `main` commit it was made from, how to build and test it.

`tools/production.json` lists each part and its files.

## How they are made

`node tools/publish-production.mjs` builds every branch from `main`, as a new commit on top of the branch's last one: a branch's history is the list of snapshots of `main` it was made from. Nothing is rewritten, the working copy is not touched, and a branch that would not change is left alone. It refuses a commit whose **CI summary** check (`.github/workflows/ci.yml`) has not passed on GitHub (step 46), so a branch Coolify deploys from never gets code that failed its tests; it asks GitHub with `gh`. `desktop-app-production` and `skip-engine-production` also wait for **Desktop summary** (`.github/workflows/desktop.yml`, the `checks` field in `tools/production.json`): if it has not passed on the commit, those two are held back, the others are refreshed, and the script ends with an error naming them. Desktop summary runs when desktop files change; for a commit where it did not, run the Desktop app workflow on `main` by hand.

```bash
node tools/publish-production.mjs --list                    # what each branch holds
node tools/publish-production.mjs                           # refresh every branch
node tools/publish-production.mjs landing-web-production    # one
node tools/publish-production.mjs --push                    # and push what changed (never forced)
node tools/publish-production.mjs --without-checks          # emergency only: skip the CI check below
node tools/publish-production.mjs --export <dir> [name]     # write a branch's files to <dir>/<name>, touch no branch (image builds)
```

**Never edit a production branch.** Change `main`, then refresh the branch. A change made on a branch would be lost, or be in the way, the next time it is refreshed.

## Things a single-part branch cannot do alone

- `desktop-app-production` starts the Skip Tracing engine at run time and in its tests: check out `skip-engine-production` beside it and set `CALLERWHALE_SERVICE_ROOT` to it.

## Coolify frontend settings

| Branch | Base directory | Dockerfile location | Container port | Health path |
| --- | --- | --- | --- | --- |
| `landing-web-production` | `/` | `/apps/website/Dockerfile` (image built in GitHub Actions since step 48) | `8080` | `/healthz` |
| `landing-dashboard-web-production` | `/` | `/apps/crm-web/Dockerfile` (image built in GitHub Actions since step 48) | `8080` | `/healthz` |
| `auth-backend-production` | `/` | `/Dockerfile` | `8101` | `/healthz` |
| `notifications-backend-production` | `/` | `/Dockerfile` | `8102` | `/healthz`; no domain |
| `gateway-backend-production` | `/` | `/Dockerfile` | `8100` | its own health check (inside the private network only) |
| `authz-backend-production` | `/` | `/Dockerfile` | `8104` | its own health check; no domain |
| `billing-backend-production` | `/` | `/Dockerfile` | `8103` | `/healthz`; no domain |
| `dialer-sms-backend-production` | `/` | `/Dockerfile` | `8113` | `/healthz`; no domain |

Choose the **Dockerfile** build pack. After refreshing a source scan, replace any saved `landing/web/Dockerfile` path with `/Dockerfile`. Both paths in Coolify must start with `/`. Each Dockerfile uses its branch root as the build context. These generated branches are the release sources; do not point these applications at `main` with base directory `/`.
