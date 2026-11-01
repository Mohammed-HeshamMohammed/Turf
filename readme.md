# Landing dashboard: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `312ea0b` (2026-11-01)
- Content id: `2b672132478c9b00028e7d70a99f713b6b4649f5` (the branch is only refreshed when this changes)
- Holds: `landing/dashboard-web`
- 14 files
- Build and test: cd landing/dashboard-web && npm ci && npm run build; Coolify Dockerfile context landing/dashboard-web, port 8080

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-dashboard-web-production --push
