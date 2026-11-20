# Desktop app: the frontend, the window container (Tauri) and the feature modules

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `/` on `main`.

- Last changed from `main` at `5c35a5d` (2026-11-20)
- Content id: `6aecb1e7e2387dd0533cf07e1f128a5984c534e8` (the branch is only refreshed when this changes)
- Holds: `package.json`, `package-lock.json`, `.npmrc`, `packages`, `Cargo.toml`, `Cargo.lock`, `apps/crm`, `apps/crm-desktop`, `crates/desktop-features`, `apps/website/package.json`, `Caller Whale CRM/env/desktop.env.example`, `Caller Whale CRM/env/README.md`
- 215 files
- Build and test: npm ci at the repository root, then npm run build in apps/crm; cargo test --workspace at the root (the window and the feature crates)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs desktop-app-production --push
