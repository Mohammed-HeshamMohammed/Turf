# Future extensions and boundaries

Status: Options planned for later decision, not approved routes or implementation.
Parent: [Master plan](README.md).

## Account website vs browser CRM

The current web rebuild includes public marketing, identity/recovery, usage/download/account/security and staff management. “Plan everything” makes those plans complete; it does not establish that every desktop feature is ready for a browser port.

If a full browser CRM is chosen, create a source/role/data/permission/state plan per module before routing it. Reuse backend truth and shared UX tokens; do not assume desktop local storage, file access, offline behavior, telephony permissions or update mechanisms work identically in a browser.

| Extension | Planning concerns before implementation |
| --- | --- |
| Leads/list import | Upload limits, original columns, mapping, worker progress, dedupe, privacy, cancellation and partial import |
| Phone evidence/Skip Tracing | Supplied vs found data, confidence/invalid/missing/offline distinctions, credit idempotency, review/override |
| Calls/SMS | Actual provider connection, permissions, consent/DNC/compliance, delivery/call states, reconnect and recording policy |
| Deals/handoffs | Stage/ownership transitions, accepting transfer, concurrency, role scopes and audit |
| Tasks/calendar | Timezones, recurring work, reminders, assignment, offline conflict and notification preference |
| Inbox/team chat | Direct/group/team scopes, membership, archives/unread, attachments and moderation/retention |
| Mail | Separate mail experience, reply/forward/threading, mailbox authorization, attachments, sending failures and abuse |
| Maps | Approximate vs exact/offline locations, address privacy, provider attribution and licensing |
| Reports/export | Authorized aggregates, date boundaries, background export, sensitive files/expiry |
| Team/settings | Workspace vs platform roles, invitations, seat rules, revocation and least privilege |
| Automations/AI | Actual capability availability, approval/defaults, data sharing, budgets, stop conditions and audit |

No demo UI is evidence that a live external service has been integrated.

## Other future options

Billing/checkout requires approved commercial terms, provider/webhook/idempotency/refund/tax contracts and a separate purchase flow. Passkeys/passwordless/email sign-in need dedicated auth security/recovery contracts; do not reuse an email MFA challenge as a general login mechanism.

A help center, public status page, blog, feature-detail SEO pages, localization, mobile app and installable web app each need a specific content/function owner and acceptance plan. Do not publish empty navigation or thin SEO pages to suggest completeness.

## Revisit triggers

Add capacity features when measured load/latency or queue behavior requires them. Add pagination/search contracts before data outgrows current bounded tables. Reconsider a web-session adapter at the session design gate; reconsider rendering/framework only when the measured functional/performance requirement justifies operational cost.

Record the trigger, owner, scope, dependency and verification before promoting any option into the active route registry.
