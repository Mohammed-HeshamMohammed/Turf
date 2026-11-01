# Notification service

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `2b7d877` (2026-11-01)
- Content id: `fdf25c679a8a0cbd9a60f53a5da7912e08846c24` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/notifications`, `services/notifications`, `env/notifications.production.example`
- 16 files
- Build and test: go test ./... in services/notifications; docker build -f Dockerfile services/notifications

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs notifications-backend-production --push
