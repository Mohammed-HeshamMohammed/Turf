# Landing site: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Full CRM Turf/` on `main`.

- Last changed from `main` at `0491000` (2026-10-30)
- Content id: `568c1599cf1b09ea2bca10abb7b2edf903c3f7ac` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/landing-web`, `landing/web`
- 53 files
- Build and test: npm install && npm run build   (static files in dist/)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
