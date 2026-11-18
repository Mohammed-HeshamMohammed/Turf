# Grafana for Caller Whale's staff, behind the login proxy (Coolify)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `850ffe1` (2026-11-18)
- Content id: `b79ec42154a2fa13420ab5a6dc14c8c415f5b68f` (the branch is only refreshed when this changes)
- Holds: `deploy/grafana`, `services/grafana-proxy`, `services/alert-relay`, `docs/plans/grafana-access.md`, `env/grafana.production.example`
- 41 files
- Build and test: go test ./... in services/grafana-proxy; in Coolify: a Docker Compose resource from this branch with deploy/grafana/compose.yml (deploy/grafana/README.md)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs grafana-production --push
