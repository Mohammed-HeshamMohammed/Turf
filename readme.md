# Landing site: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/landing/web/` on `main`.

- Last changed from `main` at `ecee4f6` (2026-11-02)
- Content id: `5dd0baa0a65876949fc97f6b7f4b97f62a5529be` (the branch is only refreshed when this changes)
- Holds: `.`
- 98 files
- Build and test: npm ci && npm run build; Coolify: base directory /, Dockerfile /Dockerfile, port 8080, health /healthz. Configure build arguments and runtime origins as documented in COOLIFY.md

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
