# Landing site: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/landing/web/` on `main`.

- Last changed from `main` at `449a0f8` (2026-11-03)
- Content id: `dfc4cb1bb927c5a617bc8040817ed216a25c2e82` (the branch is only refreshed when this changes)
- Holds: `.`
- 99 files
- Build and test: npm ci && npm run build; Coolify: base directory /, Dockerfile /Dockerfile, port 8080, health /healthz. Configure build arguments and runtime origins as documented in COOLIFY.md

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
