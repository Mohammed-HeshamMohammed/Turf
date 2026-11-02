# Landing dashboard: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/landing/dashboard-web/` on `main`.

- Last changed from `main` at `7bfb598` (2026-11-02)
- Content id: `f135b42db529d0f2952d1a66e6922eab50cfb1c7` (the branch is only refreshed when this changes)
- Holds: `.`
- 14 files
- Build and test: npm ci && npm run build; Coolify: base directory /, Dockerfile /Dockerfile, port 8080, health /healthz

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-dashboard-web-production --push
