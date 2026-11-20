# Repository and releases

**Written:** 2026-11-18, from a read-only audit of the repository and its production branches, checked against the tools' own documentation (sources at the end). **State:** plan only, nothing built. Index and build order: [README.md](README.md).

How the code is laid out, how a change reaches production, and what protects `main`. It covers the whole repository, including the desktop apps and the Python engine, because they share folders, CI and release paths with the web version.

## What exists today (read 2026-11-18)

- The repository is public, `main` has no branch protection or rulesets, there is no CODEOWNERS file, and the latest "Check CRM and services" run on `main` failed (the step 41 restore test reads the database login wrongly from a URL with a password).
- Three top-level products: `Caller Whale CRM/` (1,186 tracked files: every service, the CRM, the website, tools, docs), `Caller Whale App/` (132: the older desktop app) and `service/` (98: the Python engine both desktop apps bundle).
- Releases are 19 production branches made by `tools/publish-production.mjs` from `tools/production.json`; Coolify builds each from source on the server. The generator assumes the folder `Caller Whale CRM` (its default base and the runtime-log path). Two old branches exist only locally (`core-api-backend-production`, `landing-backend-production`); three old feature branches (`crm/*`) and 17 Dependabot branches are on GitHub.
- Shared code is copied by sync scripts: the calendar (3 copies), the auth client (2), the Go token check (`tools/auth-verify`), the runtime log (one copy per service) and the browser error reporter (2 copies, no check).
- Six services under `services/features/` are scaffolds with no business logic, yet have Dockerfiles, sit in `deploy/compose.yml` and in the Rust workspace.
- CI has no job for notifications, assistant, learning, mcp, live, importing-lists, alert-relay, grafana-proxy, the alert rules or the tools.
- Three deployment descriptions: Coolify (live), `deploy/compose.yml` and `infra/k8s` (four services); some docs still say Dokploy.
- Valuable files exist only locally and are ignored: the secret files in `env/`, `.env.local`, `backend/scripts/.dev-accounts.json`, `.vercel/project.json`, `landing/site/.env.example`. About 6.5 GB of build caches, 4.3 GB of it left from the removed core API.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D375 | The repository stays public for now (owner, 2026-11-18). Nothing secret is ever committed: configuration and credentials live in the environment, so the code could be published at any moment without exposing a credential. Revisited before the first real agency joins. | 46 |
| D376 | `main` is protected: every change arrives by pull request, and the CI summary check must pass before it merges, for admins too. A CODEOWNERS file names who reviews each folder. | 46 |
| D377 | Required checks never depend on path filters, because a workflow skipped by a path filter leaves its check pending and blocks merging. One CI workflow always runs and decides inside it which jobs to skip; a job skipped by its own condition reports success. | 46 |
| D378 | Every deployed service, image and tool has a CI job. A part with no CI job is not deployed. The desktop apps and the engine they ship have their own development and release, so their checks live in their own workflows (`desktop.yml`, `older-app.yml`), run when their files change and do not block `main`; a desktop release is built only from a commit where they passed (owner, 2026-11-19). | 46 |
| D379 | A release is an image built once in GitHub Actions, tagged with its commit, pushed to the GitHub container registry with a record of how it was built, and deployed by Coolify by its digest through Coolify's deploy webhook. Nothing is built on the production server. The images are **private** (owner, 2026-11-19: the repository goes private later), so each server logs in to the registry, old versions are deleted to stay within private storage, and GitHub's signed build record is used only while the repository is public (the build record in the registry stays either way). Each image is built from its production branch's files, so it matches what Coolify builds today. | 47, 48 |
| D380 | The production branches stay until each Coolify resource has moved to images, then each is retired. The two old local branches, the merged `crm/*` branches and superseded Dependabot branches are retired after the owner reviews them. | 48 |
| D381 | Production deploys go through a GitHub "production" environment that needs the owner's or the cofounder's approval. (Free for a public repository, D375.) | 48 |
| D382 | The repository becomes one monorepo at its root, with no spaces in folder names: `apps/`, `services/`, `engines/`, `packages/`, `crates/`, `scaffolds/`, `contracts/`, `deploy/`, `env/`, `tools/`, `docs/`. | 51 to 54 |
| D383 | Shared code has one original. Web code uses npm workspaces over `apps/*` and `packages/*` (packages named `@callerwhale/*`); shared Go code is its own module (`go.work` is not committed, as the Go reference advises); Rust is one workspace at the root; each Python project keeps its own `pyproject.toml` and lock file, since its services deploy separately. The copy-and-sync scripts go. | 49, 50, 52, 53 |
| D384 | Scaffolds (services with no business logic) live in `scaffolds/`, apart from production services, and are never built into a production image or deployed. | 54 |
| D385 | Coolify is the one deployment path. The Compose file is for local development only; the Kubernetes files are kept as history. | 54 |
| D386 | Before any move, the local-only files (secret env files, dev accounts, the Vercel link) are copied to a safe place, and every ignore rule moves in the same commit as the folder it protects, so a secret file never becomes visible to Git. | 46, 54 |
| D387 | Build caches and leftovers (the removed core API's 4.3 GB, the Rust `target` folders) are deleted only with the owner's approval. | 46 |
| D388 | The Python engine is shipped with the desktop app as a Tauri sidecar (`bundle.externalBin`, one file per target), the way Tauri documents for programs built with PyInstaller, once a build proves it; until then it stays a bundled resource. | 52 |

## The target layout

```
callerwhale/
├─ package.json            npm workspaces: apps/*, packages/*
├─ Cargo.toml              Rust workspace: apps/crm-desktop, crates/*
├─ .github/                CODEOWNERS, dependabot.yml, workflows (ci, images, release-desktop, reusable per-service CI)
├─ apps/                   crm, crm-desktop, crm-web, website, lists-desktop (or archived)
├─ services/               gateway auth authz billing notifications crm-core messaging live assistant
│                          learning mcp dialer-sms importing-lists alert-relay grafana-proxy
├─ engines/skip-engine/    the Python engine
├─ packages/               calendar, auth-client, error-report (npm); go/authverify, go/runtimelog (Go)
├─ crates/                 desktop-features (scaffolds today)
├─ scaffolds/              ai-campaigns backup-restore crm exports leads-map skip-tracing
├─ contracts/  env/  tools/
├─ deploy/                 coolify (a note per resource), monitoring, compose (local), k8s (history)
└─ docs/                   plans, operations, legal, design, product, history, assets
```

| Today | Becomes |
| --- | --- |
| `Caller Whale CRM/desktop/frontend/react` | `apps/crm` |
| `Caller Whale CRM/desktop/container/rust` | `apps/crm-desktop` |
| `Caller Whale CRM/desktop/backend/features/*` | `crates/desktop-features/*` |
| `Caller Whale CRM/landing/dashboard-web` | `apps/crm-web` |
| `Caller Whale CRM/landing/site` | `apps/website` |
| `Caller Whale CRM/landing/web` (empty) | removed; it is in history |
| `Caller Whale App` | `apps/lists-desktop`, or archived (open question) |
| `service` | `engines/skip-engine` |
| `Caller Whale CRM/services/<name>`, `services/features/{dialer-sms,importing-lists}` | `services/<name>` |
| `Caller Whale CRM/services/features/<6 scaffolds>` | `scaffolds/<name>` |
| `Caller Whale CRM/shared/calendar`, `services/auth/clients`, the error reporter copies | `packages/{calendar,auth-client,error-report}` |
| `Caller Whale CRM/tools/auth-verify`, `tools/runtime-log` | `packages/go/{authverify,runtimelog}` |
| `Caller Whale CRM/{contracts,env,tools}` | `contracts`, `env`, `tools` |
| `Caller Whale CRM/deploy/compose.yml`, `deploy/grafana`, `infra/k8s` | `deploy/compose`, `deploy/monitoring`, `deploy/k8s` |
| `Caller Whale CRM/docs/*`, `docs/`, `Design notes/` | `docs/*`, `docs/product`, `docs/design` |
| `docs/PLAN.md`, `FULL_CRM_CALLERWHALE_STRUCTURE.md` | `docs/history/` |
| `Caller Whale CRM/screenshots`, `er diagrams` | `docs/assets/` |
| `Caller Whale CRM/Cargo.toml`, `Cargo.lock` | the repository root |

## Production branches, one by one

| Branch | Built from today | Becomes |
| --- | --- | --- |
| auth, authz, billing, notifications, gateway, crm-core, messaging, live, assistant, learning, mcp (`-backend-production`) | `Caller Whale CRM/services/<name>` | image `ghcr.io/<owner>/cw-<name>` from `services/<name>`; branch retired |
| dialer-sms, importing-lists (`-backend-production`) | `…/services/features/<name>` | image from `services/<name>`; branch retired |
| landing-web-production | `…/landing/site` | image from `apps/website`; branch retired |
| landing-dashboard-web-production | `landing/dashboard-web` and `desktop/frontend/react` | image from `apps/crm-web` and `apps/crm`; branch retired |
| grafana-production | `deploy/grafana`, `services/grafana-proxy`, `services/alert-relay` | images for both services and the monitoring images; the Coolify compose uses `image:` lines; branch retired |
| desktop-app-production | `desktop/`, the auth client, the Rust workspace | the desktop release workflow's installer and update feed; branch retired |
| skip-engine-production | `service` | built inside the desktop release; branch retired |
| core-api-backend-production, landing-backend-production (local only) | removed services | retired after review |

## Steps

Each step is a pull request into a protected `main` and keeps the current production branches working until a step says otherwise. After each, every production branch is regenerated into scratch refs (not pushed) and compared with today's, and the full tests and image builds run.

| Step | What | Changes together | Depends on |
| --- | --- | --- | --- |
| 46 | Safety and protection: copy the local-only files to a safe place (D386); record every branch's commit and tag `main`; fix the red restore test; one CI workflow that always runs, with a job for every deployed part through a reusable per-service workflow (D377, D378); CODEOWNERS and a ruleset on `main` requiring the CI summary (D376); the publish script refuses a commit whose checks are not green. Build caches stay until the owner says (D387). | `.github/workflows/*`, `.github/CODEOWNERS`, the repository's rules, `tools/publish-production.mjs`, `services/crm-core/restore_test.go` | - |
| 47 | Images built in CI beside the branches: on `main`, build each service's existing Dockerfile, push it to the GitHub container registry tagged with the commit, record its provenance, and print its digest (D379). Coolify does not change yet. **Built 2026-11-19:** `images.yml` runs after CI passes on `main` (and rebuilds everything on Mondays), builds each image from its branch's files (`publish-production.mjs --export`, the images listed in `production.json`), tags it `sha-<commit>` and `content-<branch content>`, skips one whose content is already in the registry, records provenance and a package list, prints the digest, checks the image is private, and keeps the newest versions only; on a pull request touching the set-up it builds without pushing. No `.dockerignore` files were needed: each build sees only its branch's files. | a new `images.yml`, the services' `.dockerignore` files | 46 |
| 48 | Coolify moves to images, one resource at a time: each becomes a Docker Image application pinned by digest, each server logs in to the registry once, deploys run through the deploy webhook after the push and wait for the "production" environment's approval (D379, D381). Order: alert-relay and grafana-proxy, learning, mcp, assistant, notifications, live, billing, authz, auth, crm-core, messaging, dialer-sms, importing-lists, the gateway last. Each moved part leaves `production.json`, and its branch is retired (D380). *Needs the owner in Coolify (Cloudflare's check).* **Part 1 built 2026-11-19 (monitoring):** in `deploy/grafana/compose.yml`, grafana-proxy and alert-relay run `${CW_GRAFANA_PROXY_IMAGE}` and `${CW_ALERT_RELAY_IMAGE}` (images by digest) instead of building on the server; `compose.local.yml` builds them locally. An image with a `deploy` entry in `production.json` (the Coolify application and setting) leaves a record when it is pushed; the Images workflow then waits for the "production" environment, writes each digest into its Coolify setting and redeploys the application once (`tools/coolify-deploy.mjs`). Both settings were set by hand in Coolify to the images of `bbd67b42`. The monitoring branch stays: it still carries the compose file and the other monitoring images. **Part 2 (every other app) is a checklist for the owner:** [coolify-image-swap.md](../coolify-image-swap.md); each app becomes a Docker Image app beside the old one (Coolify cannot convert a Git app), the owner copies its secrets, and Claude adds its `deploy` entry. **Part 2 done 2026-11-20:** every app in Coolify is a Docker Image app pinned by digest, and every image that runs on its own has a `deploy` entry, so each new image deploys after the "production" approval. Billing still restarts until the short `core-api=` token leaves `BILLING_TOKENS` (it was down before the move too). The production branches stay for now: the images are built from their exported files, and old branches are retired after review in step 54. | `images.yml` (deploy job), `tools/production.json`, the Coolify resources, the monitoring compose (`image:` lines) | 47 |
| 49 | npm workspaces: a root `package.json` over `apps/*` and `packages/*`; the calendar, auth client and error reporter become `@callerwhale/*` packages; their copies, sync scripts and copy tests go (D383). | the apps' imports, the website and CRM Dockerfiles (root build context with a per-Dockerfile ignore file), the CI npm jobs, Dependabot's npm entry | 46 |
| 50 | Shared Go modules: `packages/go/authverify` and `packages/go/runtimelog`; each service requires them; the token copies and the runtime-log injection go (D383). | the services' `go.mod` and Dockerfiles, the gateway job in `ci.yml`, the generator and image job, the `.gitignore` runtime-log rules | 46 |
| 51 | Services move to `services/<name>` (D382). By now Coolify deploys images, so no Coolify path depends on these folders. | CI paths, the image job's contexts, Dependabot directories, the compose contexts, `env-notes.mjs`, `tools/infra.json` and `stack.json`, docs | 48, 50 |
| 52 | Apps and desktop move to `apps/crm`, `apps/crm-desktop`, `apps/crm-web`, `apps/website`; one Rust workspace at the root; the engine tried as a Tauri sidecar (D388). | `tauri.conf.json`, `scripts/tauri.mjs`, the desktop release workflow, `.claude/launch.json`, the crm-web Dockerfile, the root `Cargo.toml`, the Vercel demo's root directory (by hand) | 49 |
| 53 | The engine moves to `engines/skip-engine` with its own `pyproject.toml` and lock file (D383); the older desktop app moves to `apps/lists-desktop` or is archived. | the sidecar path, both packaging configs, the release workflow, the CI Python steps, Dependabot and audits, the engine's `.gitignore` rules | 52 |
| 54 | Scaffolds to `scaffolds/` and out of the production compose (D384); `env/` moves in the same commit as its ignore rules (D386); Kubernetes kept as history and Coolify notes written (D385); docs moved; the empty `Caller Whale CRM/` removed; `AGENTS.md` changes from "publish the production branches" to "images build in CI"; old branches retired after review (D380). | `.gitignore`, `deploy/`, `docs/`, `AGENTS.md`, the root README | 51, 52, 53 |

## Where everything stood before the move (2026-11-19)

Tag `before-reorganisation-2026-11-19` (pushed) marks `main` at `03304ae0c3`. Each branch then:

| Branch | Commit | Last changed |
| --- | --- | --- |
| `assistant-backend-production` | `51f70c0313` | 2026-11-18 |
| `auth-backend-production` | `8251eaa52e` | 2026-11-18 |
| `authz-backend-production` | `b7bbe92420` | 2026-11-18 |
| `billing-backend-production` | `45a1c1acca` | 2026-11-18 |
| `core-api-backend-production` | `0ffe142496` | 2026-11-03 |
| `crm-core-backend-production` | `215766d67d` | 2026-11-18 |
| `desktop-app-production` | `a883991aa1` | 2026-11-18 |
| `dialer-sms-backend-production` | `f115964f4c` | 2026-11-18 |
| `gateway-backend-production` | `45d3a94ba4` | 2026-11-18 |
| `grafana-production` | `f12c4ba556` | 2026-11-18 |
| `importing-lists-backend-production` | `c11b4ca1b2` | 2026-11-18 |
| `landing-backend-production` | `0ff83572a4` | 2026-11-03 |
| `landing-dashboard-web-production` | `577f8ef729` | 2026-11-18 |
| `landing-web-production` | `adc435473e` | 2026-11-18 |
| `learning-backend-production` | `7fde7ad3a6` | 2026-11-10 |
| `live-backend-production` | `281c6a0225` | 2026-11-18 |
| `main` | `03304ae0c3` | 2026-11-18 |
| `mcp-backend-production` | `865bf616ad` | 2026-11-18 |
| `messaging-backend-production` | `99028d8f9b` | 2026-11-18 |
| `notifications-backend-production` | `ffae153889` | 2026-11-18 |
| `skip-engine-production` | `9ed55d710e` | 2026-11-18 |

The local-only files (D386) were copied, unread, to `X:/callerwhale-local-backup/2026-11-19/` outside the repository, at the same paths: the `env/*.env` files, `.env.local`, `.vercel/`, `landing/site/.env.example` and `backend/scripts/.dev-accounts.json`. The owner approved deleting the build caches (D387): `services/core-api/` (only the Rust `target` and two generated files, 4.3 GB) and the root `target/` (2.2 GB) went, with the Python caches.

## Open questions

1. Keep the older desktop app (`Caller Whale App`) as its own product, or archive it (step 53)?
2. Whether the repository goes private before the first real agency (D375). Going private would need a paid GitHub plan to keep the approval step (D381).

## Not verified

- Coolify's actual settings for each resource (blocked by Cloudflare's check), and whether several Coolify applications may share one repository and branch with different base directories (not stated in Coolify's docs; the image model does not depend on it).
- Image builds for every service in CI, containers running with the new build contexts, both desktop installers and the sidecar change.
- Dependabot's exact wording on `directories` globs and `groups` (only a summary could be read), and GitHub's main merge-queue page.

## Sources

- Coolify: [Base Directory](https://coolify.io/docs/applications/configuration/general), [Dockerfile builds](https://coolify.io/docs/applications/builds/dockerfile), [Docker Compose](https://coolify.io/docs/applications/builds/docker-compose), [deploying an image](https://coolify.io/docs/applications/deployments/docker-image), [deploy webhooks](https://coolify.io/docs/core/automation/deploy-webhooks), [automatic deployments and watch paths](https://coolify.io/docs/applications/deployments/automatic-deployments), [GitHub Actions](https://coolify.io/docs/applications/sources/github/actions), [registries](https://coolify.io/docs/applications/builds/docker-registries)
- GitHub: [required checks and skipped workflows](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/troubleshooting-required-status-checks), [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners), [environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment), [reusable workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows), [container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [build provenance](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds), [Dependabot options](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- Toolchains: [Turborepo repository structure](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository), [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces), [Go workspaces](https://go.dev/doc/tutorial/workspaces) and [Go modules reference](https://go.dev/ref/mod), [Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html), [uv workspaces](https://docs.astral.sh/uv/concepts/projects/workspaces/), [Tauri sidecars](https://v2.tauri.app/develop/sidecar/), [Docker build context](https://docs.docker.com/build/concepts/context/), [Twelve-Factor: build, release, run](https://12factor.net/build-release-run) and [config](https://12factor.net/config)
