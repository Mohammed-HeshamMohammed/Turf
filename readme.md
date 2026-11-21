# Desktop app: the frontend, the window container (Tauri) and the feature modules

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `/` on `main`.

- Last changed from `main` at `040c547` (2026-11-21)
- Content id: `e3c96933dce6b9a4c171452bbe49ec39401a8bc0` (the branch is only refreshed when this changes)
- Holds: `package.json`, `package-lock.json`, `.npmrc`, `packages`, `Cargo.toml`, `Cargo.lock`, `apps/crm`, `apps/crm-desktop`, `crates/desktop-features`, `apps/website/package.json`, `env/desktop.env.example`, `env/README.md`
- 224 files
- Build and test: npm ci at the repository root, then npm run build in apps/crm; cargo test --workspace at the root (the window and the feature crates)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs desktop-app-production --push
