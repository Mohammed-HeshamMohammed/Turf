# Desktop app: the frontend, the window container (Tauri) and the feature modules

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `/` on `main`.

- Last changed from `main` at `6462647` (2026-11-20)
- Content id: `693fb584a1fac5f946594c6affa8b5bc9466a0fc` (the branch is only refreshed when this changes)
- Holds: `package.json`, `package-lock.json`, `.npmrc`, `packages`, `Caller Whale CRM/.gitignore`, `Caller Whale CRM/desktop`, `Caller Whale CRM/landing/site/package.json`, `Caller Whale CRM/env/desktop.env.example`, `Caller Whale CRM/env/README.md`, and the Cargo workspace file and lock for it
- 219 files
- Build and test: npm install && npm run build in desktop/frontend/react; cargo test --workspace at the root (the feature modules); cargo build in desktop/container/rust. Their tests start the Skip Tracing engine from skip-engine-production: set CALLERWHALE_SERVICE_ROOT to its checkout

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs desktop-app-production --push
