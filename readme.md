# Landing site: backend

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `5e6147d` (2026-10-28)
- Content id: `1f0d3e7be4e307858059c75b79df4280b7d20d81` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-api`, `landing/api`
- 16 files
- Build and test: npm start   (Node 24+, no dependencies)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-backend-production --push
