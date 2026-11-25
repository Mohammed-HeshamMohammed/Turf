# Desktop app: the frontend, the window container (Tauri) and the feature modules

A **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as on `main`, so it can be
deployed, handed over or reviewed on its own.

| | |
| --- | --- |
| Made from | `main` at `d67b9da` (2026-11-25) |
| Content id | `ed4edb99f40ed1250dfd2f4274b0a8dc557416e9` (the branch changes only when this does) |
| Holds | `package.json`, `package-lock.json`, `.npmrc`, `packages`, `Cargo.toml`, `Cargo.lock`, `apps/crm`, `apps/crm-desktop`, `crates/desktop-features`, `apps/website/package.json`, `env/desktop.env.example`, `env/README.md` (224 files) |
| Settings | `.env.example` at the root (from `env/desktop.env.example` on `main`): paste into Coolify's Developer View; secrets stay in Coolify |
| Build and test | npm ci at the repository root, then npm run build in apps/crm; cargo test --workspace at the root (the window and the feature crates) |

## Do not edit this branch

Change the code on `main`; after its CI passes, refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs desktop-app-production --push
