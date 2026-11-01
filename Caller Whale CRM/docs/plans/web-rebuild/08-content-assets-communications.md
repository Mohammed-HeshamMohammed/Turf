# Content, assets, product truth and communications

Status: Proposed. Parent: [Master plan](README.md).

## Content model

One reviewed source for each capability: id, audience/job, short/long copy, readiness, evidence source/date, limitation, screenshot/caption, CTA and content owner. Public pages reuse it; pricing rules stay in plan.js/approved pricing documents. Avoid independent claims in hero, FAQ and signup that drift apart.

Readiness vocabulary: working in app, preview with sample data, planned. Distinguish coded, configured, connected and verified-live. A published mockup is not evidence of a connected capability.

Use property-outreach language, not architecture sales language. Explain Skip Tracing exactly as currently implemented; avoid “find any owner's number,” guaranteed deals, fabricated time savings, calling availability or customer counts. Label drafts and future items adjacent to the claim.

## Copy ownership

Product owner approves access/pricing promises and capability status. Design/frontend own clarity and layout; backend owner confirms behavior; operations verifies production dependencies; business/legal owner approves policies/contact identity. These are responsibilities, not assumed additional staff.

Every page gets purpose, section copy, CTA destination and fallback/error copy. Errors explain recoverable next steps without exposing provider/internal SQL details. Avoid blaming a person for a service outage.

## Image and font inventory

For every asset track id, original source/path, rights/provenance, dimensions, intended crop/focal point, alt/caption, theme use and readiness. Keep original files outside optimized public derivatives as appropriate.

Architecture communicates property context. Actual product UI comes from safe sample captures of the current app, never an image model's reconstruction. Audit old Turf marks, demo names/numbers, private records, stale buttons and unreadable text. Do not alter a capture to imply an unbuilt function.

Deliver hero desktop/tablet/mobile sources, account-panel image, genuine screenshots for each selected story, social image, favicon/brand assets and licensed local fonts/fallbacks. Track asset budgets from measured baseline; prohibit decorative background video by default.

## Transactional message matrix

| Message | Trigger/owner | Required content | Failure handling |
| --- | --- | --- | --- |
| Access request receipt | Landing service if implemented | Accurate receipt; no invitation claim | Stored vs delivered distinguished |
| Contact receipt/staff notification | Landing + notifications when integrated | Reference/category and safe reply path | Durable receipt; controlled retry, not duplicate sends |
| Invitation | Core -> notifications | Product, invited account context, actual sign-in destination | Invitation saved separately; resend allowed after fixing mail |
| Verify email | Auth -> notifications | Caller Whale identity, expiring link, ignore-if-unrequested | Generic request responses/cooldowns |
| Password reset | Auth -> notifications | Actual reset destination, expiry, no password in mail | Single-use proof; don't disclose existence |
| Email verification code | Auth -> notifications | Attempt context/expiry; no unrelated marketing | Rate limit/resend invalidation according to contract |
| Device approval/security change | Auth, optional notification dependency | Device/time, relevant action and report route | In-app state remains server authority |

HTML messages need readable plain-text alternatives and usable mobile links. A sender uses a configured authorized Caller Whale mailbox/domain. SPF/DKIM/DMARC, verified destinations, SMTP authorization and actual delivery are operations gates, not things a frontend mockup establishes. Do not change DNS/MX or forwarding as part of this planning package.

## Privacy and consent

Separate operational receipts from marketing permission. Do not pre-check marketing consent or bundle it into product access. Policy copy must match data fields, subprocessors, retention and deletion capability. Collect only useful supported fields; no age/date-of-birth requirement invented for signup.

Recovery/provider URLs and signed download URLs are sensitive. Do not include them in session replay, screenshots, tracking payloads or support exports. Redact email addresses and account ids from diagnostic screenshots unless needed and authorized.

## Localization and dates

English first unless another language is chosen. Keep strings separable from layout. Test long copy, RTL feasibility and translated controls without promising a translation launch. Currency, billing units and timezone are explicit; credit period remains server-defined UTC even if displayed locally.

## Search/social content

Unique title/description per route, actual page-level canonical, meaningful social crop and no private data. Metadata updates during client navigation as well as direct load. Structured data matches visible true information. Build sitemap only from canonical eligible route records.

## Completion evidence

A reviewed content/asset manifest, capability-status audit, verified message-link routes, real staging send/receive checks when implementing messages, and a sign-off record for legal/policy claims. No fake notification-success UI substitutes for delivery evidence.
