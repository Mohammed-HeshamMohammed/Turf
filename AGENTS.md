# Repository workflow

After completing and verifying requested changes, commit them to `main` and push to `origin/main` as part of finishing the task. This is the user's standing instruction.

Then refresh and push the production branches (see `Caller Whale CRM/docs/plans/production-branches.md`): from the repo root run `node "Caller Whale CRM/tools/publish-production.mjs" --push`. It only adds commits to branches whose files changed and never force-pushes. Never edit a production branch by hand. This is also the user's standing instruction.
