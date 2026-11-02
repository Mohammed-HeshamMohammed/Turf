# Caller Whale: identity, purpose and product goals

Last reviewed: 2 November 2026.

This is the shared identity brief for people designing, writing, building and operating Caller Whale. It consolidates owner decisions, current source and existing product plans. It is not a statement that every planned capability is available, a replacement for the feature specifications, or a new approval of pricing or legal claims.

## 1. What Caller Whale is

**Caller Whale is a workspace for property outreach: organize property records, review phone evidence, prepare conversations, record outcomes and keep follow-ups moving.**

The desktop CRM is the core working product. The public website explains the work and its availability; the account website supports access, account management and downloads. Team workflows connect callers, researchers, closers and managers around the same record.

The product should help someone answer four questions without assembling the story from several places:

1. What do we know about this property and contact?
2. What evidence do we have for the supplied phone numbers?
3. What happened in the last conversation?
4. Who owns the next step, and when is it due?

Residential architecture supplies context for that work. Caller Whale is not a brokerage, property marketplace, construction company or architecture studio.

## 2. Name and identity

| Item | Direction |
| --- | --- |
| Public name | **Caller Whale** — two words, capital C and W. |
| Machine/domain spelling | `callerwhale`, subject to the actual configuration contract. |
| Name origin | A play on **killer whale**, with “caller” connecting the orca identity to outreach. |
| Brand symbol | An orca. The animal should carry the identity without needing a telephone illustration. |
| Personality | Focused, assured, precise and practical. Strong visual character; calm and helpful product behavior. |
| Legacy name | Turf is historical context, not the public brand. Do not introduce it into new copy or assets. |

A visual name change does not authorize blindly renaming database identifiers, environment keys, package names or update channels. Those require a checked compatibility change. Do not create conflicting spellings in the interface to match a legacy technical identifier.

### Current logo and future mark

The owner supplied the temporary black orca artwork now referenced by the website at `Caller Whale CRM/landing/web/public/brand/callerwhale-orca.png`. The `Logo` component in `landing/web/src/components.jsx` displays it through a cropped SVG viewBox; it does not redraw the animal.

Use that supplied mark consistently while it remains the selected temporary asset. Do not replace it with a generated concept or a stock whale during an unrelated design task. Permanent production artwork, licensing/provenance, vector master, small-size variants and safe-area rules still need a dedicated review.

Earlier exploration favored an imposing, whale-first silhouette rather than a cute mascot, with calling symbolism optional. That is background for a future logo brief, not authority to alter the supplied temporary artwork. Future explorations must be reviewed against the owner's latest reference.

## 3. Who the product serves

| Audience | Main job | What the experience should emphasize |
| --- | --- | --- |
| Solo property-outreach operator | Manage records, conversations and next steps alone | Fast access to the lead and a clear next action. |
| Caller | Prepare outreach and record the outcome | Phone evidence, context, notes and callbacks together. |
| Researcher | Prepare and review property/contact information | Original data, checked results, uncertainty and corrections. |
| Closer | Continue a qualified conversation | Useful history, accepted handoffs and deal progress. |
| Manager or workspace owner | Coordinate the team's work | Ownership, overdue actions, permissions and relevant activity. |
| Client or partner | Review deliberately shared work | Only the records, notes and conversations shared with them. |
| Platform staff | Support and administer the service | Restricted administrative tools, fresh verification and an audit trail. |

Do not make the public site read like a general-purpose AI platform. Do not frame the product only around administrators; most people come to work property leads.

## 4. Purpose and goals

**Purpose:** help people carry a property record from an imported list to a useful conversation and an accountable next step.

### Product goals

- Keep property details, contact evidence, activity and follow-ups connected to the record.
- Reduce unnecessary switching between lists, notes, conversation context and team handoffs.
- Make ownership and the next action clear, including when a handoff is waiting for acceptance.
- Preserve original information and distinguish it from checked, inferred or manually corrected information.
- Support an individual and a team without making the individual navigate a team-sized interface.
- Let people understand the status of their work: saved, pending, failed, preview or unavailable.
- Keep records useful outside the app through supported exports, with authorization and privacy intact.

### Website goals

- Explain the business and intended user in the first screen.
- Show genuine product evidence and describe what works today.
- Give each page one clear purpose and a relevant next action.
- Make access requests, sign-in, recovery and account tasks understandable.
- Keep marketing pages discoverable while protecting account and staff information through actual authorization.
- Carry one recognizable identity across the public website, account website, desktop app and transactional messages.

### Business and operational goals

- Make the offering understandable: what is included, what is optional, and what incurs usage costs.
- Price features from their value and cost; assemble plans from reviewed feature decisions.
- Build trust through accurate availability, clear limits and recoverable failures.
- Make support and operations readable: actionable errors, consistent runtime logs and verified deployment status.

These are directional goals, not measured outcomes. Do not turn them into percentage savings, productivity gains, customer counts or guarantees without evidence.

## 5. The workflow that should shape the product story

**Import and organize → review evidence → prepare outreach → record the outcome → follow up or hand off.**

| Stage | What to communicate |
| --- | --- |
| Import and organize | Work from the customer's records; preserve useful source information and explain mapping or duplicate handling. |
| Review evidence | Show what is known, uncertain, invalid or missing. A score is not proof of ownership or reachability. |
| Prepare outreach | Bring the lead, contact evidence and previous activity together. |
| Record an outcome | Leave useful notes and a clear result attached to the record. |
| Follow up or hand off | Assign the next action and time. Where the handoff contract requires acceptance, do not imply ownership moved before it did. |

Calling is part of the intended story, but a preview is not evidence that live telephony is available. Reviewing supplied phone numbers must not be advertised as discovering new owner numbers.

## 6. Product boundaries and honest availability

Feature documents describe both agreed direction and incomplete work. “Agreed,” “coded,” “configured,” “connected” and “verified live” are different states.

| Area | Identity and scope rule |
| --- | --- |
| Lists and phone evidence | Core part of the property-outreach story. Describe the actual checks and source of the numbers. |
| CRM, tasks, deals and handoffs | Keep the record and next action central; sample screens remain labeled as samples. |
| Calling, SMS and campaigns | Publish availability only after the relevant provider and end-to-end behavior are verified. |
| Inbox and Mail | Chat and email have different jobs. Keep email's own mailbox/thread/reply experience rather than disguising it as a chat. |
| Maps and property imagery | Support record context. Decorative buildings do not replace functional software evidence. |
| Account website | Access, downloads, usage, account and security are distinct from a complete browser CRM. |
| Current standalone dashboard | Its README describes a foundation without live account data, login or API integration. A deployed page alone does not prove those connections exist. |
| Desktop and mobile | Desktop is the current product focus. Do not promise all platforms, full offline operation or a mobile app from a mockup or plan. |
| Billing | Draft launch pricing and a plan builder do not mean checkout is open. |

The latest homepage source explicitly labels the Calls workspace as a product preview, live telephony as unavailable, new-number discovery as planned, and access as by invitation. Verify current implementation before changing those statements.

## 7. Visual direction

The selected direction combines **Precision Studio's structure**, the editorial restraint of **“Tools for a more focused tomorrow,”** **Whale Studio's image/text layering**, and **Instrument's architectural imagery and typography**. Those references guide composition; they do not authorize copying another site's assets, branding or page verbatim.

| Element | Rule |
| --- | --- |
| Overall feel | Deliberate editorial composition, clear hierarchy and useful software detail. |
| Color family | Warm cream/ivory, charcoal and restrained peach/sand accents. No lime palette borrowed from a reference. |
| Typography | Schibsted Grotesk is used in the current website. Use readable body/form text and short, deliberately broken headings. A proposed condensed display face needs a separate review. |
| Structure | Open grids, aligned edges, consistent gutters, fine rules and varied section proportions. |
| Photography | Residential architecture and work context with intentional crops, rights/provenance and responsive sources. |
| Hero layering | Images may pass behind selected headline edges while text remains readable live HTML. Reduce overlap on smaller screens. |
| Product proof | Genuine captures with safe sample data and adjacent readiness labels. Never generate fake app screens to imply working features. |
| Controls | Familiar labels, consistent states, visible focus and adequate targets. Avoid decoration that competes with the task. |
| Footer | Useful grouped destinations, clear identity, legal/support links and accessible appearance controls. Keep it concise. |
| Dashboard | Related colors and typography, compact rows and task-oriented structure. It should not become a marketing hero on every page. |
| Dark mode | Designed surface levels and readable warm text; preserve photographic colors rather than inverting images. |

### Current tokens versus concept colors

The current shared website stylesheet `landing/web/src/landing.css` defines, among others:

| Token | Current value | Role |
| --- | --- | --- |
| `--page` | `#ececec` | Base page surface. |
| `--ink` | `#121212` | Main text. |
| `--dark` | `#191919` | Dark brand surface. |
| `--accent` | `#ecc394` | Warm accent. |
| `--accent-soft` | `#fbdfc2` | Soft accent surface. |

The selected concept also explored ivory `#F4EFE7`, charcoal `#202321` and peach `#FFB594`. Those are concept values, not a silently adopted replacement token system or an accessibility certification. Check component/theme overrides in source before using a token. Contrast, focus and status colors require testing in both themes.

### Spacing and motion

Use a shared 4px spacing scale and consistent 8px multiples for primary rhythm. Match density to the job: tables, forms and reading pages need different amounts of space. Review every section, including empty/error states, not only the hero.

Motion explains opening, selection, progress and relationships. Respect reduced motion; avoid scroll hijacking, decorative delays and movement behind active reading text. Collapse lower-priority panels only where that interaction is intentional, preserve unsaved input, and park collapsed board rails at their nearest relevant edge.

## 8. Writing and voice

Sound like a knowledgeable colleague explaining the work. Use short, concrete language, familiar nouns and direct actions. Keep subtext only when it answers a real question or prevents an error.

| Prefer | Avoid |
| --- | --- |
| “Review phone evidence” | “Find any owner's number.” |
| “Record the outcome and set a follow-up” | “Supercharge your pipeline.” |
| “Shown with sample data” | Presenting a demo as a customer's live workspace. |
| “Calling is a preview” | “Start calling now” when telephony is not connected. |
| “Join the waitlist” or the supported access action | A sign-up promise that bypasses the current invitation policy. |
| “We couldn't save this. Try again.” with a useful next step | Raw SQL/provider errors, or blaming the user for a server outage. |
| Specific, verified safeguards | “Completely secure,” “unhackable” or absolute privacy guarantees. |

Do not invent testimonials, customer logos, usage figures, uptime, rankings or competitor savings. Older comparison prices in planning documents are not publication-ready facts. Public positioning should explain the category and actual offering rather than make unsupported attacks on named competitors.

A concise internal description is: **Property lists, phone evidence and follow-ups, together.** This summarizes the existing product story; it is not a newly approved permanent tagline.

## 9. Trust is part of the identity

- Keep Firebase authentication behind the auth service; the public web and dashboard should consume Caller Whale's supported auth contract, not hold privileged credentials.
- Enforce authorization at the gateway and the relevant backend. A hidden link, `robots.txt` or `noindex` is not an access control.
- Administrative work belongs in an authorized dashboard mode, with fresh authentication/second-factor checks and time/idle limits according to the security contract. Do not restore a public `/admin` experience as a shortcut.
- Grafana belongs behind authorized staff access. An embedded panel does not secure a publicly reachable monitoring endpoint by itself.
- Make verification, recovery and session expiry understandable; do not bypass protection to make a screen appear to work.
- Keep secrets and private records out of browser bundles, public screenshots, analytics and routine logs.
- Distinguish a saved request from a delivered email, a built image from a healthy container, and a local preview from a verified production capability.

These are product requirements, not a claim that every service currently satisfies them. Use the security and operations plans for implementation and evidence.

## 10. Commercial principles

The existing feature plans use Solo, Duo, Team and Pro as planning groupings, with trial and client/partner-seat rules described in their own documents. They are not an immutable launch catalog.

The commercial direction is a useful CRM base with individually understood features and transparent usage costs. Review the feature economics before choosing final plan prices. The older positioning proposal says to discount software margin rather than external costs, and to keep paid usage extras distinct. Treat that as a proposal to check against approved commercial rules, not a universal live billing promise.

Do not publish a numerical competitor comparison, “unlimited” usage, guaranteed savings or a free/trial entitlement without current approval and enforceable terms. Keep price arithmetic in the pricing source and feature documents rather than copying a second price table into this brief.

## 11. Direction of travel

| Horizon | Goal | Evidence needed before describing it as complete |
| --- | --- | --- |
| Foundation | One recognizable identity across the homepage, account entry and app | Reviewed assets, responsive/theme checks, correct destinations and honest copy. |
| Reliable access | Usable sign-in, recovery, verification and protected account tasks | End-to-end auth/provider/mail checks and server authorization. |
| Connected workflow | Move from sample screens to supported real-data operations | Per-feature data contracts, permissions and successful/failure-path tests. |
| Communication services | Connect calling, messaging and email where approved | Provider integration, consent/compliance requirements and actual delivery/call evidence. |
| Broader platforms | Consider browser CRM modules and future mobile workflows | Explicit scope, platform-specific UX/data/security plans and release evidence. |

No dates or launch commitments are established by this table.

## 12. How to judge a design or product change

1. Can a visitor tell that this is software for property outreach?
2. Does the page or component have a clear job and next action?
3. Is the information useful, or is it repeated decoration/subtext?
4. Does the visual treatment improve the existing experience rather than erase a useful design?
5. Are evidence, ownership and the next step clear where they matter?
6. Are sample, planned and live capabilities labeled honestly?
7. Does it work on a narrow screen, by keyboard, at zoom and with reduced motion?
8. Are private data, staff tools and credentials protected by the actual system?
9. Do failures explain what happened and what the person can do next?
10. Has the claimed result been verified at the right level?

Measure comprehension, task completion, access/recovery success, import errors, overdue follow-ups, handoff acceptance and support issues where appropriate. Set targets from a baseline; do not invent results or collect private data merely to fill a dashboard.

## 13. Sources, authority and maintenance

The owner's latest explicit decision takes precedence. For current behavior, check source and deployment evidence. A planning document records intent; an older feature table is not proof of current availability.

| Source | Use |
| --- | --- |
| [Selected visual direction](../Caller%20Whale%20CRM/docs/plans/web-rebuild/05-selected-direction.md) | Owner-selected composition, imagery and concept constraints. |
| [Homepage reconstruction](../Caller%20Whale%20CRM/docs/design/homepage-reconstruction.md) | Later implementation decisions, supplied temporary mark and section treatment. |
| [Shared experience](../Caller%20Whale%20CRM/docs/plans/web-rebuild/01-experience.md) | Layout, interactions, accessibility and section-by-section review. |
| [Content and assets](../Caller%20Whale%20CRM/docs/plans/web-rebuild/08-content-assets-communications.md) | Claims, imagery, messages, consent and readiness vocabulary. |
| [Feature index](../Caller%20Whale%20CRM/docs/features/README.md) | Feature scope, decisions and unresolved work; follow each feature's status. |
| [Positioning proposal](../Caller%20Whale%20CRM/docs/plans/positioning.md) | Historical commercial thinking; prices/comparisons require fresh review. |
| [Future scope](../Caller%20Whale%20CRM/docs/plans/web-rebuild/13-future-scope.md) | Boundaries for browser CRM, mobile and other extensions. |
| [Dashboard foundation](../Caller%20Whale%20CRM/landing/dashboard-web/README.md) | Actual standalone web-dashboard scope and integration limits. |
| [Runtime log standard](Runtime%20logs.md) | Shared operational presentation and service coverage. |

Update this brief when the owner changes the business direction, selects permanent brand assets, approves commercial promises or verifies a major capability for release. Keep the review date and source links current. Do not use this document to override a feature contract or conceal an unresolved operational problem.
