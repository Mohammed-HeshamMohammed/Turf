# Gateway

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `5e6147d` (2026-10-28)
- Content id: `25da23c49021dc70f5e1036778b2a47054215c38` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/gateway`, `services/gateway`
- 14 files
- Build and test: go test ./... in services/gateway; docker build services/gateway

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs gateway-backend-production --push
