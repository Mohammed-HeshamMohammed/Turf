# Production branches

One branch per part of Caller Whale, each holding **only that part's files, at the same paths as on `main`**, so a part can be
deployed, handed over or reviewed on its own. `tools/production.json` lists them; `tools/publish-production.mjs` makes them.

**Names follow `main`'s folders** (restructured 2026-11-22): `services/<name>` → `<name>-backend-production`, `apps/<name>` →
`<name>-production`, `engines/skip-engine` → `skip-engine-production`. The Monitoring branch keeps `grafana-production`, because
Coolify reads its compose file from that branch.

## The branches

**Retired 2026-11-25 (the owner):** Coolify runs every app below as an image, so no app branch is kept any more. The 16 rows
with a Coolify image app are `"branch": false` in `production.json`: they still define what goes into their images (`--export`,
from `main`, in `images.yml`), but `publish-production.mjs` no longer makes or pushes their branches, and the branches were deleted
from GitHub. Only `grafana-production` (Coolify still builds five Monitoring services from its compose file), `desktop-app-production`
and `skip-engine-production` are kept. The "Branch" column below is the part's name in `production.json`.

| Branch | Holds (paths as on `main`) | Images built from it | How it runs |
| --- | --- | --- | --- |
| `website-production` | `apps/website` and the npm workspace | `cw-website` | Coolify image app (callerwhale.com) |
| `crm-web-production` | `apps/crm-web`, `apps/crm` and the npm workspace | `cw-crm-web` | Coolify image app (app.callerwhale.com) |
| `auth-backend-production` | `services/auth`, `packages/go` | `cw-auth` | Coolify image app, alias `auth`, 8101 |
| `authz-backend-production` | `services/authz`, `packages/go` | `cw-authz` | Coolify image app, alias `authz`, 8104 |
| `notifications-backend-production` | `services/notifications`, `packages/go` | `cw-notifications` | Coolify image app, alias `notifications`, 8102 |
| `gateway-backend-production` | `services/gateway`, `packages/go` | `cw-gateway` | Coolify image app, the one public entry, 8100 |
| `crm-core-backend-production` | `services/crm-core`, `packages/go` (not `bench/`) | `cw-crm-core`, `cw-crm-merge`, `cw-crm-outbox` | three Coolify image apps: 8107, 8120, 8121 |
| `messaging-backend-production` | `services/messaging`, `packages/go` | `cw-messaging` | Coolify image app, alias `messaging`, 8108 |
| `live-backend-production` | `services/live`, `packages/go` | `cw-live` | Coolify image app, alias `centrifugo`, 8000 |
| `telnyx-backend-production` | `services/telnyx`, `packages/go` | `cw-dialer-sms` (every part in one, until the switch) and the six `cw-telnyx-phone-*` / `cw-telnyx-sms-*` | Coolify image app `dialer-sms` (8113) now; six apps (8113, 8122-8126) after the switch |
| `importing-lists-backend-production` | `services/importing-lists`, `packages/go` | `cw-importing-lists` | Coolify image app, alias `importing-lists`, 8111 |
| `importing-worker-backend-production` | `services/importing-worker`, `packages/go` | `cw-importing-worker` | Coolify image app, alias `importing-worker`, 8119 |
| `assistant-backend-production` | `services/assistant`, `packages/go` | `cw-assistant` | Coolify image app, 8109 |
| `learning-backend-production` | `services/learning`, `packages/go` | `cw-learning` | Coolify image app |
| `mcp-backend-production` | `services/mcp`, `packages/go` | `cw-mcp` | Coolify image app |
| `billing-backend-production` | `services/billing`, `packages/go` | `cw-billing` | Coolify image app, 8103 (parked) |
| `grafana-production` | `deploy/grafana` (from `deploy/monitoring`), `services/grafana-proxy`, `services/alert-relay`, `packages/go` | `cw-grafana-proxy`, `cw-alert-relay`, `cw-grafana`, `cw-prometheus`, `cw-blackbox`, `cw-loki`, `cw-alloy` | Coolify Docker Compose resource read from this branch |
| `desktop-app-production` | `apps/crm`, `apps/crm-desktop`, `crates/desktop-features`, the npm and Cargo workspaces | none (the desktop installers) | built by `desktop.yml` |
| `skip-engine-production` | `engines/skip-engine` at the branch root | none | run by the desktop app |

Before 2026-11-22 the website was `landing-web-production`, the CRM web app `landing-dashboard-web-production` and Telnyx
`dialer-sms-backend-production`; those old branches stop changing and can be deleted once nothing reads them (the owner decides).

## What is in a branch

- **The part's files at `main`'s paths**, plus `LICENSE`, `.gitignore` and the part's settings example as `.env.example` (from
  `env/<part>.production.example`). Web branches carry the npm workspace (root `package.json`, lock file, `.npmrc`, `packages/` and
  the other web app's `package.json`, which npm needs to check the lock file); Go services carry `packages/go`; the desktop branch
  carries the Cargo workspace cut down to the members present. `exclude` in `production.json` leaves out files that belong on `main`
  only (crm-core's `bench/`, crm-web's README).
- **A generated `readme.md`** on every branch (GitHub shows it on the branch's page): what it is, the `main` commit it was made from,
  its content id, what it holds, its settings file, how to build and test it, and the images built from it with their Coolify apps.

## How they are made

`node tools/publish-production.mjs` builds every branch from `main`, as a new commit on top of the branch's last one: a branch's
history is the list of snapshots of `main` it was made from. Nothing is rewritten or force-pushed, the working copy is not touched,
and a branch whose files did not change is left alone (its **content id**, the tree of its files without the readme, decides). It
refuses a commit whose **CI summary** has not passed on GitHub. `desktop-app-production` and `skip-engine-production` also wait for
**Desktop summary** (`desktop.yml`). It reads the local `main`, so update it first (`git switch main && git pull`).

**Docs never build or release anything.** A change of only `docs/` and the Markdown files at the repository root (README, AGENTS,
SECURITY) runs no tests on `main` (CI summary still passes) and builds no image (`tools/ci-parts.mjs`, `docsOnly`). Images never
hold `docs/`: a branch that carries a guide (Grafana's) still gets it, but the image's content id leaves it out, so editing a doc
never rebuilds or redeploys an image. Markdown elsewhere is not docs: the website builds its legal pages from `.md` files.

```bash
node tools/publish-production.mjs --list                    # what each branch holds
node tools/publish-production.mjs                           # refresh every branch
node tools/publish-production.mjs website-production        # one
node tools/publish-production.mjs --push                    # and push what changed (never forced)
node tools/publish-production.mjs --without-checks          # emergency only: skip the CI check
node tools/publish-production.mjs --export <dir> [name]     # write a branch's files to <dir>/<name>, touch no branch (image builds)
```

**Never edit a production branch.** Change `main`, then refresh the branch.

## Images

`.github/workflows/images.yml` builds each image from its branch's files (`--export`, the readme left out), tags it with the content
id, and builds only images whose content changed. An image with a `deploy` entry in `production.json` is then put into its Coolify
app by digest, after the "production" environment's approval (`tools/coolify-deploy.mjs`). So a readme or a branch rename never
rebuilds an image; a change to a part's files does.

## Things a single-part branch cannot do alone

- `desktop-app-production` starts the Skip Tracing engine at run time and in its tests: check out `skip-engine-production` beside it
  and set `CALLERWHALE_SERVICE_ROOT` to it.
