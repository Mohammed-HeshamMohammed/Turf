# Grafana for Caller Whale's staff, behind the login proxy (Coolify)

A **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as on `main`, so it can be
deployed, handed over or reviewed on its own.

| | |
| --- | --- |
| Made from | `main` at `efc57db` (2026-11-27) |
| Content id | `f0acf8e4b5fe85f0743768ce570783688808fd02` (the branch changes only when this does) |
| Holds | `deploy/monitoring (as deploy/grafana)`, `services/grafana-proxy`, `services/alert-relay`, `packages/go`, `env/grafana.production.example` (51 files) |
| Settings | `.env.example` at the root (from `env/grafana.production.example` on `main`): paste into Coolify's Developer View; secrets stay in Coolify |
| Build and test | go test ./... in services/grafana-proxy; in Coolify: a Docker Compose resource from this branch with deploy/grafana/compose.yml (deploy/grafana/README.md) |

## Images

Built by GitHub Actions from this branch's files (`.github/workflows/images.yml`), tagged with the content id, and deployed after
the "production" approval when they have a Coolify app.

| Image | Dockerfile | Runs as |
| --- | --- | --- |
| `cw-grafana-proxy` | `services/grafana-proxy/Dockerfile` | Coolify app `cs7nxvwhusacrlrsmolbqll9` (setting `CW_GRAFANA_PROXY_IMAGE`) |
| `cw-alert-relay` | `services/alert-relay/Dockerfile` | Coolify app `cs7nxvwhusacrlrsmolbqll9` (setting `CW_ALERT_RELAY_IMAGE`) |
| `cw-grafana` | `deploy/grafana/grafana/Dockerfile` | not deployed by itself yet |
| `cw-prometheus` | `deploy/grafana/prometheus/Dockerfile` | not deployed by itself yet |
| `cw-blackbox` | `deploy/grafana/blackbox/Dockerfile` | not deployed by itself yet |
| `cw-loki` | `deploy/grafana/loki/Dockerfile` | not deployed by itself yet |
| `cw-alloy` | `deploy/grafana/alloy/Dockerfile` | not deployed by itself yet |

## Do not edit this branch

Change the code on `main`; after its CI passes, refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs grafana-production --push
