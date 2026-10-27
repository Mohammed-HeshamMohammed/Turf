# Production branches

One branch per part of Turf, each holding **only that part's code**, so a part can be deployed, handed over or reviewed on its own. They are named `<part>-production`:

| Branch | What it holds |
| --- | --- |
| `landing-web-production` | The landing site's frontend (`landing/web`) |
| `landing-backend-production` | The landing site's backend (`landing/api`) |
| `auth-backend-production` | The authentication service (`services/auth`) |
| `notifications-backend-production` | The notification service |
| `billing-backend-production` | The billing service |
| `gateway-backend-production` | The gateway |
| `core-api-backend-production` | The core API: the CRM server and the website it serves, with the auth verifier crate and the contract it checks |
| `importing-lists-`, `skip-tracing-`, `dialer-sms-`, `leads-map-`, `crm-`, `ai-campaigns-`, `exports-`, `backup-restore-` `backend-production` | One feature service each |
| `desktop-frontend-production` | The desktop app's and the CRM's frontend (`desktop/frontend/react`) |
| `desktop-container-production` | The desktop window (Tauri), with the frontend it packs |
| `desktop-backend-production` | The desktop feature modules (`desktop/backend`) |
| `deploy-production` | The compose file that runs every service on one machine |
| `turf-app-production` | The original Turf desktop app (`Turf/`) |
| `skip-engine-production` | The Skip Tracing engine (`service/`) |

## What is in a branch

- The part's folder(s), at the same paths as in `Full CRM Turf/` on `main` (the `Full CRM Turf/` prefix itself is dropped), and `.gitignore`.
- For a Rust service: the Cargo workspace file cut down to the members present, and `Cargo.lock`. Dockerfile lines that copy a folder the branch does not have are removed.
- A generated `PRODUCTION.md`: what it is, which `main` commit it was made from, how to build and test it.

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

- `desktop-container-production` includes the frontend because Tauri builds it. The container also expects the Skip Tracing engine (`skip-engine-production`) beside it at run time.
- `deploy-production` is the compose file only; it builds the services from their own branches checked out side by side.
- The older `crm/<part>` branches are full working copies, kept for development. The production branches are what to deploy.
