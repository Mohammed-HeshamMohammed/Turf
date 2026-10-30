# Skip Tracing engine (Python)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `service/` on `main`.

- Last changed from `main` at `0491000` (2026-10-30)
- Content id: `a91ba8e74c09e68c8d1c3bddb7627d7d8a2de532` (the branch is only refreshed when this changes)
- Holds: `.`
- 98 files
- Build and test: pip install -r requirements.txt pytest && python -m pytest

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs skip-engine-production --push
