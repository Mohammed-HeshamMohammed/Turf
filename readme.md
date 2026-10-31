# Landing site: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `de54f53` (2026-10-31)
- Content id: `77070dd7b7c1dfe7b8dfda7653b0eddffaaf89a0` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-web`, `landing/web`, `env/landing-web.production.example`
- 55 files
- Build and test: npm install && npm run build   (static files in dist/)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
