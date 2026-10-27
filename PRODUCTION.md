# Core API (the CRM server, and the website it serves)

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `681bdbb` (2026-10-27)
- Content id: `20084fcb0b6329e011ba883effad6adccf6c52cd` (the branch is only refreshed when this changes)
- Holds: `services/core-api`, `infra/k8s/core-api`, `infra/k8s/core-api-worker`, `services/auth/verify`, `contracts/api-v1.yaml`, `tools/load-env.sh`, `tools/env-init.mjs`, `env/core-api.env.example`, `env/worker.env.example`, `env/README.md`
- 103 files
- Build and test: cd services/core-api/rust && cargo test --workspace   (needs PostgreSQL: services/core-api/README.md)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs core-api-backend-production --push
