# Notification service

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `411612e` (2026-11-03)
- Content id: `00cd706cd504c8c7a23a24a8b19942432ed28322` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/notifications`, `services/notifications`, `env/notifications.production.example`
- 19 files
- Build and test: go test ./... in services/notifications; docker build -f Dockerfile services/notifications

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs notifications-backend-production --push
