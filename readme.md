# Landing site

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/landing/site/` on `main`.

- Last changed from `main` at `9567dc9` (2026-11-04)
- Content id: `654d3753f516980d7128088ccc23e994150f202d` (the branch is only refreshed when this changes)
- Holds: `.`
- 20 files
- Build and test: npm ci && npm run build; Coolify: base directory /, Dockerfile /Dockerfile, port 8080, health /healthz. Set VITE_CALLERWHALE_AUTH_URL as a build variable (env/landing-web.production.example)

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs landing-web-production --push
