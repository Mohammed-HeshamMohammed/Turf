# Security policy

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue.
We answer within 3 working days and fix serious issues within a week.

## What is covered

The services under `services/`, the web apps and desktop app under `apps/`, the engine under `engines/`, and the deployment files
under `deploy/`. Scaffolds under `scaffolds/` are not deployed.

## How we keep it safe

- Every pull request runs CI and CodeQL; `main` accepts changes only by pull request with a passing CI summary.
- Secret scanning with push protection blocks committed credentials. Secrets live only in Coolify, never in the repository.
- Dependabot opens security updates at once and version updates monthly; minor and patch updates merge after CI passes.
- `.github/workflows/audit.yml` checks what each container ships against known advisories every morning.
