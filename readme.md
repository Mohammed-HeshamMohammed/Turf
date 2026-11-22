# Grafana for Caller Whale's staff, behind the login proxy (Coolify)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `/` on `main`.

- Last changed from `main` at `ccd92bb` (2026-11-22)
- Content id: `671baee2048bd64d8ceaba323fd675ac3236d591` (the branch is only refreshed when this changes)
- Holds: `deploy/monitoring (as deploy/grafana)`, `services/grafana-proxy`, `services/alert-relay`, `packages/go`, `docs/plans/grafana-access.md`, `env/grafana.production.example`
- 52 files
- Build and test: go test ./... in services/grafana-proxy; in Coolify: a Docker Compose resource from this branch with deploy/grafana/compose.yml (deploy/grafana/README.md)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs grafana-production --push
