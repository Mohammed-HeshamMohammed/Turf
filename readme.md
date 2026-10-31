# Core API (the CRM server, and the website it serves)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `5595a5f` (2026-10-31)
- Content id: `028a2ac80b711471efa8c9e2f7a6041982e09333` (the branch is only refreshed when this changes)
- Holds: `services/core-api`, `infra/k8s/core-api`, `infra/k8s/core-api-worker`, `services/auth/verify`, `contracts/api-v1.yaml`, `tools/load-env.sh`, `tools/env-init.mjs`, `env/core-api.env.example`, `env/worker.env.example`, `env/README.md`, `env/core-api.production.example`, `env/worker.production.example`
- 105 files
- Build and test: cd services/core-api/rust && cargo test --workspace   (needs PostgreSQL: services/core-api/README.md)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs core-api-backend-production --push
