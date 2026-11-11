# Brief for the lawyer (2026-11-10)

Caller Whale is a CRM for lead and calling teams (web app, desktop app, website). This brief says what it is, what personal data it handles and where, who the parties are, what the documents say, what is not decided, and what we ask you to do. It was written by the product team (with an AI assistant) from the code and the deployment, not by a lawyer; every statement of law in it comes from [../plans/learning-store-us-law.md](../plans/learning-store-us-law.md) and its sources and needs your check.

## 1. What we ask

1. Review and correct the **Terms of Service, Privacy Notice, Data Processing Addendum and Acceptable Use and Calling Policy** (`landing/site/src/legal/*.md`, published at /terms, /privacy, /dpa, /acceptable-use). Fill the highlighted `[PLACEHOLDERS]`.
2. Say whether the **learning copy** (section 4) is lawful as designed, in which states, and under which role (service provider/processor, controller, or data broker), and what must change.
3. Review the **retention schedule**, **breach plan** and **key custody** documents in this folder.
4. Say what is needed for **calling and texting** (TCPA, state laws) and for **skip tracing** (section 5), which are not covered by the texts beyond a general policy.
5. Tell us the order: what must be true **before** real customers' lists go through, and what can follow.

## 2. Parties and roles (to confirm)

- **Caller Whale** [LEGAL NAME, STATE OF FORMATION, ADDRESS, OFFICERS]: operates the service.
- **Customers**: businesses (sole operators to teams) who upload lists of leads (property owners and similar). They decide why the data is used.
- **People in lists** ("data subjects"): have no relationship with Caller Whale; they are the customers' leads.
- **Staff**: the owners and a few staff accounts (owner, cofounder, system admin, tester roles).
- **Service providers** (section 6).

## 3. Product and data flows

| Part | What it does | Personal data | Where stored |
|---|---|---|---|
| Website (callerwhale.com) | marketing, sign-up and sign-in, account, pricing, contact form, "Remove my information" | visitor and account data | static site; forms go to the gateway |
| Auth service | accounts, sessions, second step, invitations, profile | name, email, phone, date of birth, picture, username, password (held by Google Firebase), security events | auth database |
| Authz service | who may do what in a workspace | user ids, roles | authz database |
| Web CRM and desktop app | the customer's workspace | customer data (leads: name, phone, email, address, notes, calls, tasks, deals) | CRM database (crm-core), desktop offline copy (desktop app only) |
| Import service | receives list files (CSV, XLSX, XLS), reads them, finds repeats, suggests column meanings | the lists | disk (deleted after loading), holding rows in the CRM database (blanked 7 days after copying to learning) |
| Billing | plans, payments via Paddle | billing identity, no card numbers | billing database, Paddle |
| Notifications | email from the service, the contact form | email addresses, messages | mail system |
| Website assistant | a chat that answers questions, may use an AI provider (OpenRouter) | visitors' messages | not stored by us |
| AI connectors (MCP) | lets a customer's AI assistant act on their account with their consent | whatever the customer lets it read | per request, not stored separately |
| Gateway | public front door, rate limits, bot checks (reCAPTCHA) | network addresses, tokens | not stored beyond logs |
| **Learning store** | see section 4 | hashes and shapes | its own database |

Calling is **simulated** in the current build ("demo" call session); real calling through a provider is planned, so telecom provider terms and call-recording consent are not yet in play. [CONFIRM WITH THE OWNER.]

## 4. The learning copy (the practice most needing review)

- **Facts:** after a customer's list is merged into leads, crm-core sends each lead once to a separate service and database. The service keeps keyed hashes of the phone and email (the key derived per workspace from one master key held by two owners), the kind of name (person or company), city, state, ZIP, a fixed list of property facts, presence flags, and the flags the customer's team later gives the lead. No names, phones, emails, street addresses, units, coordinates, notes or recordings. Rows expire after 2 years. Customers' administrators can switch it off and erase it; deleting a list erases its rows; a public page lets any person have their phone or email removed in every workspace and added to a suppression list. Nothing is sold, shared or licensed; learning is per workspace. It is **switched on** in production as of 2026-11-10 (the owner's decision) while the texts above are new and unreviewed.
- **Purpose:** to improve the service, starting with smart calling order and timing for each customer's own workspace. Pooling patterns across customers (aggregated, non-personal, with minimum group sizes) is a possible later step; giving flags about named people to other customers is **not** planned.
- **Our reading of the law (please check):** service-provider/processor use for "building or improving the service" under California's regulations and the other states' laws is allowed if there is no sale/share, no profile-building for another business, and the contract says so; hashed identifiers are still personal information; keeping it per workspace and never providing it to anyone keeps us outside the data-broker laws; the FTC's model-deletion remedy makes truthful notices and clean deletion important. See the law map for sources.
- **Questions:** see section 7.

## 5. Other features with their own legal questions

- **Skip tracing** (desktop app engine): finds a phone or address for a person from supplied data and (planned) outside sources. Needs a review of permissible purposes (GLBA, DPPA, FCRA), vendor contracts and state laws before outside data is used. [CONFIRM WHAT SOURCES ARE USED.]
- **Call history import** (ReadyMode exports) and **call outcomes**: customer data about calls; recording and consent laws apply to the customer.
- **Staff access**: owners can see customer workspaces they are members of; the platform owner has a staff workspace. Access to customer data by staff needs a policy.
- **Minors**: 18+ only; date of birth is asked at sign-up; no other age checks.
- **Cookies and tracking**: the site uses sign-in storage; no analytics or advertising trackers are known. [CONFIRM.]

## 6. Service providers (subprocessors) to list and contract

| Provider | For | Data |
|---|---|---|
| Server host (VPS) and Coolify | hosting, containers, databases | everything stored |
| Google Firebase Authentication | sign-in identity, passwords, Google sign-in | emails, hashed passwords, ids |
| Google reCAPTCHA | bot protection | network and browser signals |
| Cloudflare | DNS and network protection | traffic |
| Paddle | payments (merchant of record) | billing identity |
| Email delivery [PROVIDER] | service emails | email addresses |
| OpenRouter and the AI model it routes to | website assistant | visitors' chat messages |
| GIPHY | GIF search in chat | search terms |
| Telegram (optional) | second-step codes | chat id, codes |
| GitHub | code and deployment | no customer data |

Data location: [WHERE THE SERVER IS]. Transfers: [TO CONFIRM].

## 7. Open questions for the lawyer

1. Role and lawful basis for the learning copy in each relevant state; is the contract language (Terms 3, DPA 2 and 3) enough; what must the privacy notice say "at collection" for people who never meet us?
2. Is a **per-workspace key** enough to treat codes as pseudonymised and avoid sale/share/broker characterisation? Is hashing worth keeping at all, versus no per-person data?
3. May we keep **anything** per person after deletion? (Default now: no.)
4. Do we have to register as a **data broker** in California, Texas, Vermont, Oregon or elsewhere? What changes if we later pool patterns?
5. **TCPA and state telemarketing laws**: what must a CRM that stores consent, do-not-call, calling hours and time zones offer, and what must the Terms and policy say? Do we need consent capture, DNC scrubbing integration or call-time enforcement in the product?
6. **Data protection assessments** required (Colorado, Virginia, Connecticut and others) for the learning use.
7. **Rights requests** process for people who reach us directly; verification; appeals; time limits.
8. **Breach law** map for 50 states; whether our DPA 72-hour promise is acceptable.
9. Whether terms re-acceptance by clickwrap (already built) is enough for the new texts for existing customers, and for the DPA (which is incorporated by reference in the Terms).
10. **Insurance** and **entity** advice (cyber, E&O).
11. **Email and text campaigns** (Feature 6): the eight questions in [`docs/plans/campaigns-law-by-state.md`](../plans/campaigns-law-by-state.md) section 8: the consent a text needs, state registration and bonds for a platform versus its customers, whether any first text to a skip-traced number can be allowed, our liability as the platform, quiet hours and caps by state, wholesaling disclosures, AI-drafted messages, and a full 50-state table. Our own all-state draft, with every disagreement between sources marked, is [`docs/plans/campaigns-law-all-states.md`](../plans/campaigns-law-all-states.md): please correct it rather than start from nothing; section 6 lists what it could not settle (above all: does a state's "telephone solicitation" cover an offer to **buy** a house).

## 8. Known gaps in the product (honest list)

- No self-service **account deletion** or **workspace closure**; they are manual (retention schedule).
- No built-in **DNC registry scrub**, **consent capture**, **calling-hours enforcement** or call recording consent; the Policy puts them on the customer.
- **Backups** policy not confirmed; erasures must reach backups on their normal cycle.
- **Log retention** not confirmed.
- No **status page** or **security contact** (security.txt) yet.
- The learning copy is **on** while the legal texts are new: switch off with `LEARNING_ENABLED=false` if you advise.
