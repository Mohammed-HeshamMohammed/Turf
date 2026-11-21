# Skip Tracing engine (Python)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `engines/skip-engine/` on `main`.

- Last changed from `main` at `040c547` (2026-11-21)
- Content id: `09a4dbc3d15d1fe3796dec91ae2088dd019f8f41` (the branch is only refreshed when this changes)
- Holds: `.`
- 100 files
- Build and test: pip install -r requirements.txt pytest && python -m pytest

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs skip-engine-production --push
