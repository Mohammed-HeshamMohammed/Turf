# Landing site: backend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `50d9e26` (2026-10-30)
- Content id: `56305760af728814924017414f8f4068e2b7cd87` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-api`, `landing/api`, `env/landing-api.production.example`
- 17 files
- Build and test: npm start   (Node 24+, no dependencies)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-backend-production --push
