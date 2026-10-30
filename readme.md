# Notification service

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `a0d0251` (2026-10-30)
- Content id: `a8b00be46ffa6c3d58baaa2f8e151e3b3535428e` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/notifications`, `services/notifications`
- 14 files
- Build and test: go test ./... in services/notifications; docker build -f Dockerfile services/notifications

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs notifications-backend-production --push
