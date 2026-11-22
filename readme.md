# Skip Tracing engine (Python)

A **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as on `main`, so it can be
deployed, handed over or reviewed on its own.

| | |
| --- | --- |
| Made from | `main` at `0caadc6` (2026-11-22) |
| Content id | `158e62b5fa2670f94ac49282b755f0245e46ed36` (the branch changes only when this does) |
| Holds | `.` (100 files) |
| Settings | none of its own |
| Build and test | pip install -r requirements.txt pytest && python -m pytest |

## Do not edit this branch

Change the code on `main`; after its CI passes, refresh the branch from a checkout of `main`:

    node tools/publish-production.mjs skip-engine-production --push
