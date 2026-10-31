# Landing site: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `262684d` (2026-10-31)
- Content id: `f62b3f99c99924ba44f979e496d41c8f17c0af69` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-web`, `landing/web`, `env/landing-web.production.example`
- 54 files
- Build and test: npm install && npm run build   (static files in dist/)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
