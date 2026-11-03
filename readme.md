# Gateway

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `d397cde` (2026-11-03)
- Content id: `e5a0c19c9db00eda5af107f711065086eda9a1b4` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/gateway`, `services/gateway`, `env/gateway.env.example`, `docs/plans/gateway.md`, `env/gateway.production.example`
- 26 files
- Build and test: go test ./... in services/gateway; docker build services/gateway

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs gateway-backend-production --push
