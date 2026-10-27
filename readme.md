# Landing site: frontend

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `573c142` (2026-10-27)
- Content id: `967d5e51353bf67ce5e359e50f8ef84f4e9eba47` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-web`, `landing/web`
- 39 files
- Build and test: npm install && npm run build   (static files in dist/)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
