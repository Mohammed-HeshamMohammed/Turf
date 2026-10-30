# Landing site: backend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `a0d0251` (2026-10-30)
- Content id: `d6287707a694622ea5e9fe5f4dc0a4d72322709e` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-api`, `landing/api`, `env/landing-api.production.example`
- 17 files
- Build and test: npm start   (Node 24+, no dependencies)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-backend-production --push
