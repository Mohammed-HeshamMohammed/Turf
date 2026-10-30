# Core API (the CRM server, and the website it serves)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `0491000` (2026-10-30)
- Content id: `efd5e8da4b7e596cab85905606d3c71701cd51ab` (the branch is only refreshed when this changes)
- Holds: `services/core-api`, `infra/k8s/core-api`, `infra/k8s/core-api-worker`, `services/auth/verify`, `contracts/api-v1.yaml`, `tools/load-env.sh`, `tools/env-init.mjs`, `env/core-api.env.example`, `env/worker.env.example`, `env/README.md`
- 107 files
- Build and test: cd services/core-api/rust && cargo test --workspace   (needs PostgreSQL: services/core-api/README.md)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs core-api-backend-production --push
