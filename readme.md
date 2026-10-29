# Landing site: frontend

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `8328117` (2026-10-30)
- Content id: `e4f12926621e0ead6205d71a51d7d10acaff3228` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-web`, `landing/web`
- 53 files
- Build and test: npm install && npm run build   (static files in dist/)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
