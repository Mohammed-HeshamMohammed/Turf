# Provisioning service: buying from providers when a customer buys

**Status:** Reserved. Nothing is built or deployed, so it costs nothing today: no container, no database, no secrets exist for it.
**Date:** 2026-11-05

## Why it exists

When a customer pays for a plan, Caller Whale buys things from providers on their behalf: a VOIP number, the minutes behind the
plan, extra minutes put into the quota bank when a workspace nears its allowance (about 4,800 of 5,000), storage. Each is a call to
a provider's API with secrets, retries, and a record of what was bought and what it cost.

## Where it lives until it is built

Inside the feature service that uses the provider (dialer-sms for VOIP, skip-tracing for data), reacting to billing's
`subscription.changed` event. That is enough while there is one provider per feature. A separate container is worth running when
**two or more providers need the same job queue, retries and secrets in one place**, or when a provider's keys should be kept away
from the feature services.

## The reserved place

| | |
| --- | --- |
| Name | `provisioning` (Coolify app "Caller Whale Provisioning", in the backend environment) |
| Port | 8105 (the next free one after authz 8104) |
| Owns | its own schema, `provisioning`; no other service reads it |
| Public address | none; reached only by events and by the dashboard through the gateway |
| Listens to | `subscription.changed` (already in `contracts/events.md`), and `usage.near_allowance` when billing starts sending it |
| Sends | `provisioning.completed` and `provisioning.failed` (to add to `contracts/events.md` when built) |

## What it would keep

One job per purchase: the workspace, what was bought (number, minutes, storage), the provider, the quantity, the provider's own
reference, the cost, and the state (asked, bought, failed). A repeated request with the same request id is the same job, so nothing
is ever bought twice. The provider's real cost goes back to the dashboard's Costs overview, so the profit shown is worked out from
what was actually paid, not only from the rates the owner types in.

## What reserving it costs

Nothing. A name and a port in a document are free. When it is built it is one more small container on the same server (roughly
20 to 50 MB of memory), with no extra hosting bill, and nothing already running changes.

## Done when

- A paid plan buys its number and minutes without anyone doing it by hand, and a failure is visible and can be retried.
- A workspace near its allowance gets minutes put in the bank before it runs out.
- The Costs overview shows what each purchase really cost.
