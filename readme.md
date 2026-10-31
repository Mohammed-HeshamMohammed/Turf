# Notification service

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `baa06cd` (2026-10-31)
- Content id: `f09e6c22de61950fc66e0b3913f89e80acffb3f3` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/notifications`, `services/notifications`, `env/notifications.production.example`
- 16 files
- Build and test: go test ./... in services/notifications; docker build -f Dockerfile services/notifications

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs notifications-backend-production --push
