# Desktop app: the frontend, the window container (Tauri) and the feature modules

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `115ec27` (2026-11-03)
- Content id: `723922017b480ce523b72fd665a9737525976371` (the branch is only refreshed when this changes)
- Holds: `desktop`, `services/auth/clients`, `env/desktop.env.example`, `env/README.md`, and the Cargo workspace file and lock for it
- 173 files
- Build and test: npm install && npm run build in desktop/frontend/react; cargo test --workspace at the root (the feature modules); cargo build in desktop/container/rust. Their tests start the Skip Tracing engine from skip-engine-production: set CALLERWHALE_SERVICE_ROOT to its checkout

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs desktop-app-production --push
