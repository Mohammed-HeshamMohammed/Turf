# Caller Whale docs

Start here. Caller Whale is a CRM for real-estate lead calling: a CRM app (desktop and browser), the public website, and the
services behind them, all in this repository.

## How it fits together

```
browser / desktop app ──► gateway (the one public entry) ──► auth · authz · crm-core · messaging · telnyx-* · importing-* · …
                                                            │
             centrifugo (live updates) ◄── messaging outbox  └──► PostgreSQL (each service its own database)
```

- **Every service is its own container** on one VPS, run by Coolify from images GitHub Actions builds. The list, with ports and
  what each does: [contracts/services.md](../contracts/services.md).
- **Services talk privately** by network name; only the gateway is public, behind Cloudflare.
- **Big services are split by work, not copied** (D389): crm-core runs as crm-core, crm-merge and crm-outbox; Telnyx calls and
  texts as six `telnyx-*` containers; importing as importing-lists and importing-worker. Auth, authz and notifications always stay
  one container each (D390).

## Where things are

| You want to | Read |
| --- | --- |
| Know who does what, and find work to take | [team/](team/README.md) (the people, the diagram, and unassigned [tasks](team/tasks/README.md)) |
| Find your way around the code | [README.md](../README.md) (the folders) and each service's own `README.md` |
| Know why things are the way they are | [The decision list (D-numbers)](plans/people-teams-chats-clients/09-repository-and-releases.md) |
| Change code and get it to `main` | [AGENTS.md](../AGENTS.md): branch, pull request, CI summary, merge commit |
| Ship to production | [Production branches and images](operations/production-branches.md), then approve the `production` environment in GitHub |
| Set up or change a Coolify app | `docs/operations/coolify-setup-*.md`, [coolify-image-swap.md](history/plans/coolify-image-swap.md) (how each app moved to its image, and the deploy puller) |
| Handle secrets, tokens and upkeep | [security-upkeep.md](operations/security-upkeep.md), [rotating-service-tokens.md](operations/rotating-service-tokens.md), [SECURITY.md](../SECURITY.md) |
| Watch the system | [grafana-access.md](operations/grafana-access.md) (Grafana, alerts) and each service's `/healthz` |
| Back up and restore | [backups-and-recovery.md](operations/backups-and-recovery.md) |
| Know what Caller Whale is and who it is for | [product/identity-and-goals.md](product/identity-and-goals.md) |
| Understand a feature and its pricing | [pricing-and-market/features/](pricing-and-market/features/README.md) (one file per feature) and [pricing-and-market/](pricing-and-market/README.md) (tiers, seats, prices, payments, competitors) |
| Check a legal point | [legal/](legal/) and the law research in [legal/research/](legal/research/) |
| See what is still being planned | [plans/](plans/README.md) |
| See the website's design | [design/](design/) and [plans/web-rebuild/](plans/web-rebuild/README.md) |

## How the docs are organised

- `docs/plans/` holds only what is still open: work not built yet or part built. Each starts with a **Status** line; trust the
  code when they disagree, and fix the doc. When a plan is finished it moves to `docs/history/plans/`, or to `docs/operations/` if
  it is a how-to that is still followed.
- `docs/history/` holds what is finished or replaced (older layouts and READMEs, finished plans, dated reviews, snapshots and
  the first prototype's ER diagrams). It is kept for the record and is not kept up to date.
- `docs/operations/` holds the how-tos for running what is built: production branches, Coolify setup, backups, monitoring,
  runtime logs, secrets and security upkeep.
- `docs/pricing-and-market/` holds the subscription side: tiers and seats, each feature's value, cost and price
  (`features/`), currencies, payment methods, usage credits, custom plans and the competitor research behind them.
- `docs/team/` holds the team: who owns what, who decides what, and the task lists waiting to be taken.
- `docs/product/` says what Caller Whale is, for whom and why.
- `docs/design/` holds the website's look (theme, layout sheets, mockup); `docs/assets/screenshots/` the app screenshots.
- `docs/legal/` holds the legal package, with the law research in `legal/research/`.
