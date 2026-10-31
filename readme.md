# Gateway

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `4217ea6` (2026-10-31)
- Content id: `48960db422f0e79b5d7978cb91bf4414ce0bf4c5` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/gateway`, `services/gateway`, `env/gateway.env.example`, `docs/plans/gateway.md`, `env/gateway.production.example`
- 18 files
- Build and test: go test ./... in services/gateway; docker build services/gateway

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs gateway-backend-production --push
