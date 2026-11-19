# Grafana for Caller Whale's staff, behind the login proxy (Coolify)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `ed02189` (2026-11-19)
- Content id: `c5cd74afcc68e5a97919a4d456af43aec98fd64e` (the branch is only refreshed when this changes)
- Holds: `deploy/grafana`, `services/grafana-proxy`, `services/alert-relay`, `docs/plans/grafana-access.md`, `env/grafana.production.example`
- 42 files
- Build and test: go test ./... in services/grafana-proxy; in Coolify: a Docker Compose resource from this branch with deploy/grafana/compose.yml (deploy/grafana/README.md)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs grafana-production --push
