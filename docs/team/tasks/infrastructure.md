# Infrastructure

Coolify and the VPS, CI and images, production branches, monitoring, backups, databases. How-tos: [operations](../../operations/).

| ID | Task | Needs | Source | Taken by | Status |
| --- | --- | --- | --- | --- | --- |
| INF-01 | Learn the setup: [production branches](../../operations/production-branches.md), the [image swap](../../history/plans/coolify-image-swap.md), each Coolify app | — | Team plan | | open |
| INF-02 | Set up the daily off-server backups of every database in Coolify, kept 30 days | — | Step 41, [backups](../../operations/backups-and-recovery.md) | | open |
| INF-03 | The first restore test, then once a month | INF-02 | Step 41 | | open |
| INF-04 | Set up ntfy and the two alert settings; check the alert rules load in the deployed Grafana | — | Step 42 | | open |
| INF-05 | The ClamAV container for scanning files on leads | — | Step 38 | | open |
| INF-06 | Amazon SES: login, leaving the sandbox, the reply domain's MX record, the SNS topic | BIZ-02 | Step 29 | | open |
| INF-07 | Google Cloud app for calendars, and Google's verification of it | BIZ-02 | Step 28 | | open |
| INF-08 | Delete the two old stopped Coolify apps (Landing Web, Dashboard) once the new ones are proven | — | [Image swap](../../history/plans/coolify-image-swap.md) | | open |
| INF-09 | Tune alert lines with real traffic | TEL-05 | Steps 39, 42 | | open |
| INF-10 | Set the agent, assistant and billing settings in Coolify (`AGENT_TOKEN`, `ASSISTANT_*`, crm-core's `BILLING_*`) | — | Step 26 | | open |
| INF-11 | A runbook for the on-call person: what each alert means and the first thing to do | INF-04 | Step 42 | | open |
