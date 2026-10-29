# Landing site: frontend

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `8f69e87` (2026-10-29)
- Content id: `311b2181cbbf3a2a1c58192d47ef1c7f4a3d636c` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-web`, `landing/web`
- 52 files
- Build and test: npm install && npm run build   (static files in dist/)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
