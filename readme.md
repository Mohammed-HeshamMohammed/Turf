# Landing site: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `50d9e26` (2026-10-30)
- Content id: `f46968a49118bf76e984fc4d3d6ae8f617b5b765` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-web`, `landing/web`, `env/landing-web.production.example`
- 53 files
- Build and test: npm install && npm run build   (static files in dist/)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
