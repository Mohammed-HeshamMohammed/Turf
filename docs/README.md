# Caller Whale docs

Everything written about Caller Whale that is not code: why things are built the way they are, what is planned, who does what,
and how the live system is run. Code-level notes stay next to the code (each app and service has its own README).

> **This repository is public.** Anyone can read what is here. Keep passwords, keys, bank details, salaries and anything a
> customer told us in confidence out of it.

## The folders

```
docs/
├── product/              what Caller Whale is and who it is for
├── ideas/                ideas that are not plans yet
├── research/             notes and sources behind a decision
├── plans/                work being built or about to be
├── tasks/                open tasks per area, and who has them
├── team/                 who is on the team and what each person owns
├── flow-charts/          diagrams of how things work
├── design/               how the apps look and feel
├── pricing-and-market/   costs, prices, market, competitors
│   └── features/         one file per feature
├── legal/                terms, privacy, consent, calling rules
├── operations/           running the live system
├── reviews/              reviews and revisions, and what changed
└── history/              finished plans and old decisions
    └── old-docs/         the old docs folder, kept as one package
```

| Folder | What you find there | Examples |
| --- | --- | --- |
| [product](product/README.md) | The product as a whole: what it is, who it is for, its goals. Start here if you are new. | Identity and goals, who the customer is |
| [ideas](ideas/README.md) | Ideas nobody has picked yet. Short is fine. | "Parallel dialing", "AI call summaries" |
| [research](research/README.md) | What we looked up before deciding: sources, comparisons, notes. Legal, market, carriers, tools. | Calling laws by state, Telnyx vs other carriers |
| [plans](plans/README.md) | A picked piece of work: what, why, the steps, the decisions and what is left. | The messaging and SMS plan, a service's plan |
| [tasks](tasks/README.md) | One file per area with its open tasks and who has each one. | Calls and texts, security, testing, web frontend |
| [team](team/README.md) | People, roles, what each person owns and decides, how work moves between people. | Org chart, who decides what |
| [flow-charts](flow-charts/README.md) | Diagrams of how something works, end to end. | Sign-in, a call, a list import, a payment |
| [design](design/README.md) | Look and feel: references, screens, themes, design decisions. | Website theme, layout sheets |
| [pricing-and-market](pricing-and-market/README.md) | What each feature costs Caller Whale to run, what it sells for, the market and competitors. | Payment methods by region, positioning |
| [pricing-and-market/features](pricing-and-market/features/README.md) | One file per feature: what it does, its running cost and its price. | Dialer and SMS, skip tracing, CRM |
| [legal](legal/README.md) | Settled legal matters: terms, privacy, consent, retention, breach response, what the lawyer decided. | Retention schedule, breach response plan |
| [operations](operations/README.md) | The live system: servers, deploys, backups, monitoring, secrets rotation, what to do when something breaks. | Backups and recovery, rotating service tokens |
| [reviews](reviews/README.md) | Reviews of UI, security or code: what was found and what was changed because of it. | A UI review of the CRM, a security review |
| [history](history/README.md) | Finished plans and replaced decisions, kept so the reasons are not lost. | A plan whose work is done |

## Where does a new document go?

Ask what the document is *for*:

- An idea nobody has picked yet → `ideas/`.
- Looking something up before a decision → `research/`.
- Work someone is building now or next → `plans/`, and its open items → `tasks/`.
- Explaining how something works, as a picture → `flow-charts/`.
- A settled legal answer → `legal/` (the reading behind it stays in `research/`).
- Keeping the live system running → `operations/`.
- What a feature costs and sells for → `pricing-and-market/features/`.
- A review and what came out of it → `reviews/`.
- Anything finished or replaced → move it to `history/`. Don't delete it.

If something fits two folders, put it in the one that matches what a reader would look for first, and link to it from the other.

## How a piece of work moves

```
ideas/  →  research/  →  plans/  →  tasks/  →  history/
picked     looked up     decided    done one   finished
           before        and        by one
           deciding      planned
```

When work changes the product, update `product/`. When it changes how something works, update or add its diagram in
`flow-charts/`.

## Writing a doc

- File names are lowercase words joined by hyphens: `calls-and-texts.md`, `backups-and-recovery.md`.
- Markdown (`.md`) for writing. Diagrams as Mermaid inside the Markdown, so they show on GitHub and can be edited as text.
- Start with one or two lines saying what the doc is and what state it is in (idea, planned, built, retired).
- Write dates as `2026-11-28`, never "yesterday" or "last week".
- Link to other docs with relative links, e.g. `[the plan](../plans/messaging.md)`.

## The old docs

`history/old-docs/` holds the whole docs folder as it was on 2026-11-27, when it left the repository. It is kept unchanged, as one
package: read from it, don't edit it. When something from there is needed again, write a fresh version in the right folder above.

Where things were in the old layout:

| Looking for | In `history/old-docs/` |
| --- | --- |
| Product identity and goals | `product/` |
| Plans still in progress (messaging and SMS, AI connectors, provisioning, web rebuild, people and teams) | `plans/` |
| Finished plans (auth, gateway, billing, crm-core, second factor and others), ER diagrams, the first PLAN.md | `history/` |
| Team, roles, how the work flows | `team/` |
| Tasks per area | `team/tasks/` |
| Legal (breach response, key custody, retention, lawyer brief) | `legal/` |
| Legal research (campaign laws by state, learning store) | `legal/research/` |
| Pricing, features, payment methods, positioning | `pricing-and-market/` |
| Running the servers (backups, deploys, Grafana, tokens, logs, security upkeep) | `operations/` |
| Design sheets, website theme, references | `design/` |
| Screenshots | `assets/screenshots/` |
