# Grafana for Turf's staff, behind the login proxy (Coolify)

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `9005249` (2026-10-30)
- Content id: `6f1d10da03f1ef54325399eb16e5fba901f5ec8b` (the branch is only refreshed when this changes)
- Holds: `deploy/grafana`, `services/grafana-proxy`, `docs/plans/grafana-access.md`
- 11 files
- Build and test: go test ./... in services/grafana-proxy; in Coolify: a Docker Compose resource from this branch with deploy/grafana/compose.yml (deploy/grafana/README.md)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs grafana-production --push
