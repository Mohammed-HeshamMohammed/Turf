# Grafana for Caller Whale's staff, behind the login proxy (Coolify)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `/` on `main`.

- Last changed from `main` at `942cb66` (2026-11-21)
- Content id: `5fb9e602375b6a0760855a3ceaf516e035679f3d` (the branch is only refreshed when this changes)
- Holds: `Caller Whale CRM/deploy/grafana (as deploy/grafana)`, `services/grafana-proxy`, `services/alert-relay`, `packages/go`, `Caller Whale CRM/docs/plans/grafana-access.md (as docs/plans/grafana-access.md)`, `Caller Whale CRM/env/grafana.production.example (as env/grafana.production.example)`
- 50 files
- Build and test: go test ./... in services/grafana-proxy; in Coolify: a Docker Compose resource from this branch with deploy/grafana/compose.yml (deploy/grafana/README.md)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs grafana-production --push
