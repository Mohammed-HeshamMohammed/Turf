# Production branches

One branch per part of Caller Whale, each holding **only that part's code**, so a part can be deployed, handed over or reviewed on its own. They are named `<part>-production`:

| Branch | What it holds |
| --- | --- |
| `landing-web-production` | The landing site's frontend (`landing/web`) |
| `landing-backend-production` | The landing site's backend (`landing/api`) |
| `auth-backend-production` | The authentication service (`services/auth`) |
| `notifications-backend-production` | The notification service |
| `gateway-backend-production` | The gateway: the one public entry point (it only answers its health check so far) |
| `core-api-backend-production` | The core API: the CRM server and the website it serves, with the auth verifier crate and the contract it checks |
| `desktop-app-production` | The whole desktop app: the frontend (`desktop/frontend/react`, also the CRM in a browser), the window container (Tauri) and the feature modules (`desktop/backend`) |
| `grafana-production` | Grafana for Caller Whale's staff and its login proxy (`deploy/grafana`, `services/grafana-proxy`), deployed on Coolify as one Docker Compose resource |
| `skip-engine-production` | The Skip Tracing engine (`service/`, Python) that the desktop app runs |

A part gets a branch when it runs as its own container on the VPS. The billing service and the eight server-side feature services are scaffolds that are not deployed yet, so they have none; the compose file and the original `Turf/` app have none either. When one needs its own, add it to `tools/production.json` and run the script.

Each server branch also carries its container file and its Kubernetes files (`infra/k8s/<part>/`): see `docs/plans/scaling-and-deployment.md`.

## What is in a branch

- The part's folder(s), at the same paths as in `Full CRM Turf/` on `main` (the `Full CRM Turf/` prefix itself is dropped), and `.gitignore`.
- For a Rust service: the Cargo workspace file cut down to the members present, and `Cargo.lock`. Dockerfile lines that copy a folder the branch does not have are removed.
- A generated `readme.md`: what it is, which `main` commit it was made from, how to build and test it.

`tools/production.json` lists each part and its files.

## How they are made

`node tools/publish-production.mjs` builds every branch from `main`, as a new commit on top of the branch's last one: a branch's history is the list of snapshots of `main` it was made from. Nothing is rewritten, the working copy is not touched, and a branch that would not change is left alone.

```bash
node tools/publish-production.mjs --list                    # what each branch holds
node tools/publish-production.mjs                           # refresh every branch
node tools/publish-production.mjs landing-web-production    # one
node tools/publish-production.mjs --push                    # and push what changed (never forced)
```

**Never edit a production branch.** Change `main`, then refresh the branch. A change made on a branch would be lost, or be in the way, the next time it is refreshed.

## Things a single-part branch cannot do alone

- `desktop-app-production` starts the Skip Tracing engine at run time and in its tests: check out `skip-engine-production` beside it and set `CALLERWHALE_SERVICE_ROOT` to it.
