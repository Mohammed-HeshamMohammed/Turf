# Skip Tracing engine (Python)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `service/` on `main`.

- Last changed from `main` at `8866413` (2026-11-18)
- Content id: `7dafb5d6e06b1b83ce0bd01dd475634b865c1fee` (the branch is only refreshed when this changes)
- Holds: `.`
- 100 files
- Build and test: pip install -r requirements.txt pytest && python -m pytest

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs skip-engine-production --push
