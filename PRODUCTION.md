# Landing site: frontend

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `547b310` (2026-10-27)
- Content id: `d89d9f8e118f8d2318743b679c7f88882993b4e7` (the branch is only refreshed when this changes)
- Holds: `landing/web`
- 30 files
- Build and test: npm install && npm run build   (static files in dist/)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
