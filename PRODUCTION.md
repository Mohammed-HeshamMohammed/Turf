# Authentication service

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `547b310` (2026-10-27)
- Content id: `abc4b30749a89ed2d9bb014a27c7d0159f9ceada` (the branch is only refreshed when this changes)
- Holds: `services/auth`, and the Cargo workspace file and lock for it
- 38 files
- Build and test: docker build -f services/auth/Dockerfile -t turf-auth .   or   cargo test -p turf-auth -p turf-auth-verify

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs auth-backend-production --push
