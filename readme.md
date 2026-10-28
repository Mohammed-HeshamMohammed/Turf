# Authentication service

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `5e6147d` (2026-10-28)
- Content id: `a47d25c447e394a191b5b00732e6d80718470edf` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/auth`, `services/auth`, and the Cargo workspace file and lock for it
- 44 files
- Build and test: docker build -f services/auth/Dockerfile -t turf-auth .   or   cargo test -p turf-auth -p turf-auth-verify

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs auth-backend-production --push
