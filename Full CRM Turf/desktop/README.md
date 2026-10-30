# Desktop

The part of Full CRM Turf that runs on the person's computer. Three folders, matching [the plan](../docs/plans/service-architecture.md):

| Folder | What | Where the code is today |
| --- | --- | --- |
| `container/rust/` | The Tauri shell only: window, menus, permissions, updater, packaging | **Moved here** from `src-tauri/` (branch `crm/desktop-container`) |
| `frontend/react/` | Every screen the person sees | **Moved here** from the root of `Full CRM Turf` (branch `crm/desktop-frontend`), with the demo files that are built from it |
| `backend/` | The Rust library the container links in, one module per feature, working offline | The Tauri commands in `src-tauri/src/` (not moved yet); the new modules in `backend/features/` are scaffolds |

## Moving the existing code in

The scaffold adds the new folders without touching the working app, so the demo, the tests and the Tauri build keep working. Moving is a separate step, one folder per pull request:

1. ~~`src-tauri/` to `container/rust/`~~ **Done.** Still to do: move the Tauri commands' logic into `backend/` modules. The container registers commands; it does not implement them.
2. ~~`src/` to `frontend/react/`~~ **Done.** Still to do: split `src/` into `app/`, `pages/`, `components/`, `styles/`, `state/`, `clients/`, `storage/`, as in `FULL_CRM_CALLERWHALE_STRUCTURE.md`, and move the demo files to `demo/`.
3. ~~Point `tauri.conf.json`, `vite.config.mjs`, `.claude/launch.json` at the new paths.~~ **Done** for both moves. The Vercel project's Root Directory must be changed by hand (see `frontend/react/README.md`).

Each desktop module has the same shape as the server service of the same feature (`services/features/<name>/`), so a feature's code is findable on both sides. A module must work with no connection; signing in and syncing are the only things that need the server.
