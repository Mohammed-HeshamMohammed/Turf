# Gateway

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `2af8d46` (2026-11-03)
- Content id: `e814ef765e062c71052ec57ca85adf2b01d1e2e6` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/gateway`, `services/gateway`, `env/gateway.env.example`, `docs/plans/gateway.md`, `env/gateway.production.example`
- 23 files
- Build and test: go test ./... in services/gateway; docker build services/gateway

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs gateway-backend-production --push
