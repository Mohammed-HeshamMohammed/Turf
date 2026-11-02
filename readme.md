# Landing site: frontend

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/landing/web/` on `main`.

- Last changed from `main` at `45b2f9e` (2026-11-02)
- Content id: `a9c644c241614cea43763f1ef210e267b5d71170` (the branch is only refreshed when this changes)
- Holds: `.`
- 93 files
- Build and test: npm ci && npm run build; Coolify: base directory /, Dockerfile /Dockerfile, port 8080, health /healthz. Configure build arguments and runtime origins as documented in COOLIFY.md

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
