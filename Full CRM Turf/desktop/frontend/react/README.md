# Desktop frontend (React)

Every screen the person sees, moved here from the root of `Full CRM Turf` (history kept). Run everything from this folder:

```bash
npm ci
npm run dev              # Vite on http://localhost:5190
npm run desktop          # the Tauri window, signed-in mode (needs a Turf server)
npm run desktop:sample   # the Tauri window on the sample workspace
npm test                 # node --test tests/*.test.mjs
npm run lint
npm run build            # dist/client, plus the Sites build files for the demo
```

`npm run tauri -- <command>` runs the Tauri CLI inside `desktop/container/rust` (`scripts/tauri.mjs`): the CLI only finds `tauri.conf.json` in the folder it runs from or below, and the container is a sibling of this folder.

## What is in this folder

| Path | What |
| --- | --- |
| `src/` | The screens, the CRM model, the clients and the sync engine. Splitting it into `app/`, `pages/`, `components/`, `styles/`, `state/`, `clients/` and `storage/` is a later step |
| `scripts/` | The dev server wrapper, the dev bridge to the Python engine, the Tauri wrapper, the sample launcher |
| `tests/` | The frontend's tests |
| `AGENTS.md`, `design-qa.md` | Design decisions for this app. They moved with the code they describe |

## The demo is still in here

The public demo (Vercel, and the Sites hosting build) is built from this same folder, so `vercel.json`, `.vercelignore`, `worker/`, `.openai/`, `scripts/prepare-sites-build.mjs` and `tests/sites-worker.test.mjs` moved with it. Moving them to `demo/` is a separate step.

**If the demo is deployed on Vercel, set the project's Root Directory to `Full CRM Turf/desktop/frontend/react`.** That setting is in the Vercel dashboard, not in this repository, so it cannot be changed from here and the demo will not build until it is.

## Paths that depend on where this folder is

- The Python engine is found at `../../../../service` (the repository root's `service/`) by `scripts/service-bridge.mjs` and `tests/engine.test.mjs`, or at `TURF_SERVICE_ROOT`.
- `desktop/container/rust/tauri.conf.json` points back here: `beforeDevCommand` and `beforeBuildCommand` run in `../../frontend/react`, and `frontendDist` is `../../frontend/react/dist/client`.
