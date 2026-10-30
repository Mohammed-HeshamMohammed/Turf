# Skip Tracing engine (Python)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `service/` on `main`.

- Last changed from `main` at `598d4ef` (2026-10-30)
- Content id: `38d4b6d00142a0cbab643b879b207951adb84c1b` (the branch is only refreshed when this changes)
- Holds: `.`
- 98 files
- Build and test: pip install -r requirements.txt pytest && python -m pytest

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs skip-engine-production --push
