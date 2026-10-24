# ADR-001: The structure of Full CRM Turf

**Status:** Proposed
**Date:** 2026-10-24
**Deciders:** Mohammed Hesham, Magdy

Read this before changing anything in `Full CRM Turf/`. It says which part of the product each piece of code belongs to, which folder it lives in, and how the parts may talk to each other. Code that does not fit one of the four parts below does not get merged until this document says where it goes.

## Context

Full CRM Turf began as a frontend-only demo (a Vite + React site on Vercel). It then grew a Tauri desktop host, a Python Skip Tracing engine, a Rust API, a Go worker, a Python worker, a website and Google sign-in. Each piece was added beside the last one, so today the folder mixes all of them:

- `src/` holds 38 React and JavaScript files side by side (screens, the state model, the API client, the sync engine, the encrypted cache, the engine client). Several files are 1,000+ lines (`Work.jsx`, `Leads.jsx`, `ui.jsx`, `DataPages.jsx`).
- `src-tauri/` is both the desktop container and the local backend (the Python bridge, sign-in, downloads).
- `backend/` is the VPS server, but `website/`, `contracts/` and `docs/saas/` sit next to it instead of inside it.
- The local engine the desktop app runs is `service/` at the repository root. It is shared with the Turf desktop app.
- Demo-only files (`vercel.json`, `worker/`, `.vercelignore`, `scripts/prepare-sites-build.mjs`, `screenshots/`) are mixed in with the product.

Nobody can tell from the tree where new code belongs, which is a large part of why the app neither looks nor works consistently.

## Decision

Full CRM Turf has **four parts**. Each part is a top-level folder, and inside each part **every language has its own folder**.

| Part | Folder | Runs where | Languages |
| --- | --- | --- | --- |
| 1. The Rust container | `container/` | The person's computer: the desktop window | Rust |
| 2. The frontend of the container | `frontend/` | Inside the container's webview (and, for the demo, a browser tab) | JavaScript / React, CSS |
| 3. The backend inside the container | `local-backend/` | The person's computer, started by the container | Rust, Python |
| 4. The backend on the VPS server | `server/` | The Hostinger VPS | Rust, Go, Python, SQL, plus the static website |

Shared definitions between the parts live in `contracts/`. Design notes live in `docs/`.

### Target tree

```text
Full CRM Turf/
├── container/                    1. THE RUST CONTAINER (Tauri 2)
│   └── rust/                        The desktop shell only: window, title bar, menus, capabilities,
│       ├── Cargo.toml               icons, packaging. Registers the local backend's commands.
│       ├── tauri.conf.json          No business logic here.
│       ├── capabilities/
│       ├── icons/
│       └── src/main.rs
│
├── frontend/                     2. THE FRONTEND OF THE CONTAINER
│   └── react/                       Everything the person sees. Talks to (3) and (4) only through
│       ├── package.json             the clients in src/clients/.
│       ├── vite.config.mjs
│       ├── index.html
│       ├── public/
│       └── src/
│           ├── app/                 Entry, routing, layout shell, sidebar, menus
│           ├── pages/               One folder per screen: dashboard/, leads/, calls/, data/,
│           │                        team/, management/, personal/ (each split into small files)
│           ├── components/          Shared UI: buttons, tables, cards, dialogs, maps, charts
│           ├── styles/              Design tokens and global CSS (one source of colours, spacing, type)
│           ├── state/               The CRM model and reducer, field vocabulary, sample data
│           ├── clients/
│           │   ├── local.js         Calls into the local backend (Tauri invoke / dev /rpc)
│           │   └── server/          VPS API client, sync engine, session, translation
│           └── storage/             IndexedDB workspace and the encrypted offline vault
│
├── local-backend/                3. THE BACKEND INSIDE THE CONTAINER
│   ├── rust/                        A library crate (turf-local) the container links in: the Tauri
│   │   ├── Cargo.toml               commands, the Python sidecar bridge, desktop sign-in, downloads,
│   │   └── src/                     local files. Every command the frontend may call is defined here.
│   │       ├── lib.rs
│   │       ├── commands.rs
│   │       ├── sidecar.rs
│   │       ├── signin.rs
│   │       └── downloads.rs
│   └── python/                      The Skip Tracing engine the sidecar runs (JSON lines over stdio).
│                                    Today this is the repository's shared service/ (see "Shared engine").
│
├── server/                       4. THE BACKEND ON THE VPS SERVER
│   ├── rust/                        Public API (Axum, sqlx): sign-in, MFA, permissions, CRM operations,
│   │   ├── Cargo.toml               sync, events, billing, OAuth. Owns the database.
│   │   └── crates/{api,grouping}/
│   ├── go/                          turf-worker: outbox events, scheduler, Redis invalidations
│   ├── python/                      turf_worker: imports, server-side Skip Tracing jobs, report PDFs
│   ├── sql/migrations/              PostgreSQL migrations (only server/rust applies them)
│   ├── website/                     The public sign-up / sign-in / account site the API serves at /
│   ├── scripts/                     Local dev: Postgres + Redis, run-api, run-worker, seed, admin
│   └── deploy/                      VPS setup: nginx, systemd units, environment templates
│
├── contracts/                    Shared definitions, never code that runs
│   ├── api-v1.yaml                  Frontend ↔ server API
│   ├── local-commands.md            Frontend ↔ local backend: every Tauri command and its payload
│   └── native/                      Native ABIs (grouping)
│
├── demo/                         The Vercel client demo only: vercel.json, .vercelignore, the Sites
│                                 worker, its build script. Deleting this folder must not break the product.
│
└── docs/                         Design QA, ER diagrams, SaaS notes, screenshots
```

### How the parts may talk

```text
 ┌──────────────────────── the person's computer ────────────────────────┐
 │                                                                         │
 │   container/rust  (Tauri window)                                        │
 │   ┌─────────────────────────────────────────────┐                       │
 │   │  frontend/react  (webview)                   │                       │
 │   │     clients/local.js ──── Tauri invoke ──────┼──► local-backend/rust │
 │   │     clients/server/  ──┐                     │        │              │
 │   └────────────────────────┼─────────────────────┘        │ JSON lines   │
 │                            │                              ▼ over stdio   │
 │                            │                      local-backend/python   │
 └────────────────────────────┼────────────────────────────────────────────┘
                              │ HTTPS  /api/v1  (contracts/api-v1.yaml)
                              ▼
 ┌──────────────────────────── the VPS ───────────────────────────────────┐
 │   server/rust (API) ──── PostgreSQL (server/sql/migrations)            │
 │        ▲    ▲                                                           │
 │        │    └── /internal + worker token ── server/go, server/python    │
 │        └── serves server/website at /                                   │
 └─────────────────────────────────────────────────────────────────────────┘
```

Rules:

1. **The frontend never touches files, processes or the database.** It reaches the computer only through `clients/local.js`, and the server only through `clients/server/`. A screen never calls `fetch` or `invoke` itself.
2. **The container is a shell.** `container/rust` creates the window and registers commands. A command's logic lives in `local-backend/rust`.
3. **Every local command is listed in `contracts/local-commands.md`**, and every server route in `contracts/api-v1.yaml`. The existing contract test (`server/rust/crates/api/tests/contract.rs`) keeps the API honest. A matching test should keep the local command list honest.
4. **Only `server/rust` connects to PostgreSQL.** The Go and Python workers claim jobs through `/internal` with a worker token, as they do today.
5. **The local backend works offline.** It must never need the VPS to open a list, run a Skip Tracing check or export a file. Signing in and syncing are the only things that need the server.
6. **Demo code stays in `demo/`.** The product must build and run with `demo/` deleted.

### Shared engine

The Python Skip Tracing engine is `service/` at the repository root. Both the Turf desktop app and Full CRM Turf run it, and `server/python` imports its phone and status rules so that a list reads the same on a laptop and on the server. Until Turf and Full CRM Turf become one product, `service/` stays where it is, and `local-backend/python/` holds only a README that points to it. When they merge, `service/` moves to `local-backend/python/`.

## Options considered

### Option A: Parts first, languages inside (chosen)

`container/`, `frontend/`, `local-backend/`, `server/`, each with `rust/`, `go/`, `python/` or `react/` inside.

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium: a one-time move plus path fixes |
| Cost | About two days, mostly re-pointing configs and splitting large screens |
| Scalability | Good: a new part or a new language adds one folder in an obvious place |
| Team familiarity | High: matches how the team already talks about the app |

**Pros:** You can see where code runs (your computer or the VPS) from its path. Ownership is clear. Each part can be built, tested and deployed alone.
**Cons:** Rust is in three places (`container/`, `local-backend/`, `server/`), so a shared Rust helper needs a home of its own.

### Option B: Languages first

`rust/`, `go/`, `python/`, `js/` at the top, with the parts inside each.

| Dimension | Assessment |
| --- | --- |
| Complexity | Medium |
| Cost | About the same as A |
| Scalability | Poor: the desktop app and the server mix inside `rust/` and `python/` |
| Team familiarity | Low |

**Pros:** One toolchain per folder. A Rust workspace can cover everything.
**Cons:** The most important line in the product (what runs on the computer and what runs on the VPS) disappears from the tree.

### Option C: Keep today's layout and only split `src/`

| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Cost | Under a day |
| Scalability | Poor |
| Team familiarity | Medium |

**Pros:** Cheapest option, and nothing has to be re-pointed.
**Cons:** The container and the local backend stay mixed, the demo stays mixed with the product, and the next feature lands wherever is convenient again.

## Trade-off analysis

A is chosen because what hurts today is not the toolchains but not knowing where code belongs and what may call what. A makes the computer/VPS line and the four parts visible in every path, and that is what the rules above need. The one real cost, Rust living in three places, is handled with a Cargo workspace at `Full CRM Turf/Cargo.toml` that lists `container/rust`, `local-backend/rust` and `server/rust`. That gives one lock file and one `cargo test --workspace` without mixing the folders.

## Consequences

- **Easier:** finding where a change goes; reviewing it (a PR that touches `frontend/` and `server/` is visibly a contract change); testing each part alone; deleting the demo.
- **Harder:** the first move re-points every config: `tauri.conf.json` (`frontendDist`, `devUrl`, the before-commands), the Vite root, `sidecar.rs`'s path to `service/`, `server/scripts/run-api.sh`'s website and `.env.local` paths, the contract test's path to `contracts/`, the Python worker's path to `service/`, `.gitattributes`, `.claude/launch.json`, and the Vercel project root.
- **To revisit:** where `service/` lives once Turf and Full CRM Turf merge; whether the frontend's sample data belongs in `demo/` instead of `state/`.

## Action items

1. [ ] Agree on this document (Mohammed, Magdy). Change **Status** to Accepted.
2. [ ] Move the demo files into `demo/` and point the Vercel project's root there. Check that the demo still deploys.
3. [ ] Split `src-tauri/` into `container/rust` (`main.rs`, config, capabilities, icons) and `local-backend/rust` (`sidecar.rs`, `signin.rs`, `downloads.rs` as a library crate). Add the Cargo workspace.
4. [ ] Move the React app into `frontend/react/`, then sort `src/` into `app/`, `pages/`, `components/`, `styles/`, `state/`, `clients/` and `storage/`. Route every `invoke` and `fetch` through `clients/`.
5. [ ] Break the 1,000+ line screens (`Work.jsx`, `Leads.jsx`, `ui.jsx`, `DataPages.jsx`) into one folder per page with small files, and move every colour, spacing and type value into `styles/` tokens. This is the step that fixes most of "doesn't look good".
6. [ ] Move `backend/` to `server/`, `backend/rust/migrations` to `server/sql/migrations`, and `website/` to `server/website`. Update `run-api.sh`, `db.rs`'s `migrate!` path, the contract test and the Python worker's path to `service/`.
7. [ ] Write `contracts/local-commands.md` (today: `service_call`, `google_sign_in_listen`, `open_in_browser`, `save_download`) and a test that compares it with the commands the container registers.
8. [ ] Add `server/deploy/` with the VPS setup now described in `docs/saas/README.md`.
9. [ ] Update `Full CRM Turf/README.md`, `server/README.md`, the root `README.md` and `.claude/launch.json` to the new paths. Run every part's tests: `npm test`, `cargo test --workspace`, `go test ./...`, pytest.
