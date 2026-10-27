# Notification service

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `547b310` (2026-10-27)
- Content id: `9cac842b0bc41ecb82b7f2a62f005fa19a37d8dc` (the branch is only refreshed when this changes)
- Holds: `services/notifications`
- 9 files
- Build and test: go test ./... in services/notifications; docker build -f Dockerfile services/notifications

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs notifications-backend-production --push
