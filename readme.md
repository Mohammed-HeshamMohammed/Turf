# Landing site: frontend

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `695a4ad` (2026-10-27)
- Content id: `c59d82dd3fa57948be46d0bc63279e08d5b1fbe8` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-web`, `landing/web`
- 39 files
- Build and test: npm install && npm run build   (static files in dist/)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
