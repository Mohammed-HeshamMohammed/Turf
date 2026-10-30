# Gateway

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `0491000` (2026-10-30)
- Content id: `75cf16ea7ffdc93a1f817b281b406581bab953e6` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/gateway`, `services/gateway`, `env/gateway.env.example`, `docs/plans/gateway.md`
- 17 files
- Build and test: go test ./... in services/gateway; docker build services/gateway

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs gateway-backend-production --push
