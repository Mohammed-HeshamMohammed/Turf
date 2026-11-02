# Landing dashboard: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/landing/dashboard-web/` on `main`.

- Last changed from `main` at `3b23a0f` (2026-11-02)
- Content id: `df9286d22bf6a356266a177976db45180c04a401` (the branch is only refreshed when this changes)
- Holds: `.`
- 13 files
- Build and test: npm ci && npm run build; Coolify: base directory /, Dockerfile /Dockerfile, port 8080, health /healthz

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-dashboard-web-production --push
