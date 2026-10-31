# Skip Tracing engine (Python)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `service/` on `main`.

- Last changed from `main` at `a070b71` (2026-10-31)
- Content id: `82c631f6a77c2ad7c03db67602e1c9b0943b1eb4` (the branch is only refreshed when this changes)
- Holds: `.`
- 99 files
- Build and test: pip install -r requirements.txt pytest && python -m pytest

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs skip-engine-production --push
