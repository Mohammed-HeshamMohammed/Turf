# Gateway

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `573c142` (2026-10-27)
- Content id: `ae555a5ce8397ffd360b1e397ff450e246713e45` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/gateway`, `services/gateway`
- 14 files
- Build and test: go test ./... in services/gateway; docker build services/gateway

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs gateway-backend-production --push
