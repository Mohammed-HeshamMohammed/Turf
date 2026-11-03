# Authentication service

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `ce0c3be` (2026-11-03)
- Content id: `318c4cb66f1f7e755eb5618a79ff83401131f4a3` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/auth`, `services/auth`, `env/auth.env.example`, `env/auth.production.example`, `env/callerwhale-auth-db.sql.example`, `env/README.md`
- 56 files
- Build and test: go test ./... in services/auth; docker build services/auth. Coolify: base directory /services/auth, Dockerfile /Dockerfile, port 8101

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs auth-backend-production --push
