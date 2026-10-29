# Authentication service

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `8328117` (2026-10-30)
- Content id: `33c71ce1d2d5af6d43fb38018c729a895a6475e0` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/auth`, `services/auth`, and the Cargo workspace file and lock for it
- 44 files
- Build and test: docker build -f services/auth/Dockerfile -t turf-auth .   or   cargo test -p turf-auth -p turf-auth-verify

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs auth-backend-production --push
