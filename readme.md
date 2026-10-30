# Landing site: backend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `0491000` (2026-10-30)
- Content id: `8671992b8a18bfaff437ef6480b50c0b54e22cf8` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-api`, `landing/api`
- 17 files
- Build and test: npm start   (Node 24+, no dependencies)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-backend-production --push
