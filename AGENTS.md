# Repository workflow

Changes reach `main` by pull request (step 46, D376). This is the user's standing instruction:

1. Start from an up-to-date `main` (`git switch main && git pull`), then work on a branch named for the change (e.g. `step-47-images`).
2. When the change is done and verified locally, commit it, push the branch and open a pull request into `main` (`gh pr create`).
3. Wait for the required check, **CI summary** (`.github/workflows/ci.yml`), to pass. If it fails, fix it on the branch.
4. Merge it with a merge commit (`gh pr merge --merge --delete-branch`), then `git switch main && git pull`.

`main` has a ruleset: no direct pushes, no force pushes, no deleting it; a pull request and a passing **CI summary** are required, for admins too. No approval is required while there is one person (GitHub does not let anyone approve their own pull request).

Then refresh and push the production branches: from the repo root, on the merged `main`, run `node tools/publish-production.mjs --push`. It refuses a commit whose **CI summary** has not passed, only adds commits to branches whose files changed and never force-pushes. Never edit a production branch by hand. This is also the user's standing instruction.
