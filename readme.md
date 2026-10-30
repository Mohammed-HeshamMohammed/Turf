# Authentication service

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `Caller Whale CRM/` on `main`.

- Last changed from `main` at `598d4ef` (2026-10-30)
- Content id: `57c75cb365fd1e48110feae9142a93c57d6e5783` (the branch is only refreshed when this changes)
- Holds: `infra/k8s/auth`, `services/auth`, and the Cargo workspace file and lock for it
- 42 files
- Build and test: docker build -f services/auth/Dockerfile -t callerwhale-auth .   or   cargo test -p callerwhale-auth -p callerwhale-auth-verify

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs auth-backend-production --push
