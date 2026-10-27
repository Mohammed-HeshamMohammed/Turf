# Notification service

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `695a4ad` (2026-10-27)
- Content id: `b9c4c14c81568d0c161f07c5f01f3834cee927fd` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/notifications`, `services/notifications`
- 14 files
- Build and test: go test ./... in services/notifications; docker build -f Dockerfile services/notifications

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs notifications-backend-production --push
