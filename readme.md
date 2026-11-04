# Notification service

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `b365c3e` (2026-11-04)
- Content id: `19df1d4cd4035ecc855dfdd0f8b784c1b3a9ecc7` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/notifications`, `services/notifications`, `env/notifications.production.example`
- 20 files
- Build and test: go test ./... in services/notifications; docker build -f Dockerfile services/notifications

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs notifications-backend-production --push
