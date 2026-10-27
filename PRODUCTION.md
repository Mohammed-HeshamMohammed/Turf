# Authentication service

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `695a4ad` (2026-10-27)
- Content id: `0868ad8d2ddeaa4154367a6b6c6868612c396e6a` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/auth`, `services/auth`, and the Cargo workspace file and lock for it
- 44 files
- Build and test: docker build -f services/auth/Dockerfile -t turf-auth .   or   cargo test -p turf-auth -p turf-auth-verify

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs auth-backend-production --push
