# Authentication service

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `449a0f8` (2026-11-03)
- Content id: `ecdb4ffb441a34c9115bb65e01e33d4824ed5313` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/auth`, `services/auth`, `env/auth.env.example`, `env/auth.production.example`, `env/callerwhale-auth-db.sql.example`, `env/README.md`, and the Cargo workspace file and lock for it
- 59 files
- Build and test: docker build -f services/auth/Dockerfile -t callerwhale-auth .   or   cargo test -p callerwhale-auth -p callerwhale-auth-verify

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs auth-backend-production --push
