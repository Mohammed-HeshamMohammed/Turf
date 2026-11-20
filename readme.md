# Skip Tracing engine (Python)

This branch is a **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as in `service/` on `main`.

- Last changed from `main` at `6462647` (2026-11-20)
- Content id: `58b7c5a2582ed67e6e03b34f3a7815fff10547b6` (the branch is only refreshed when this changes)
- Holds: `.`
- 100 files
- Build and test: pip install -r requirements.txt pytest && python -m pytest

Do not edit it here. Change the code on `main`, then refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs skip-engine-production --push
