# The team

Who is on Caller Whale, what each person owns, and who decides what. The work waiting to be done is in [tasks/](tasks/README.md),
grouped by area and **not assigned to anyone yet**.

Written 2026-11-23. Titles marked *later* are what a person grows into; until then everyone goes by the title now.

## The diagrams

### Who reports to whom

```mermaid
flowchart TB
    CEO["<b>Mohammed</b><br/>Founder · CEO · CTO for now<br/><i>Lead backend engineer (Go)</i>"]

    subgraph COMPANY["Running the company"]
        direction TB
        COO["<b>Magdy</b><br/>Co-founder · COO and Chief of Staff<br/><i>Project manager</i>"]
        CFO["<b>Malaa</b><br/>CFO · Head of US Operations<br/><i>Finance and operations</i>"]
        CPO["<b>Rana</b><br/>Product and Research Lead<br/><i>Technical product manager · AI · Compliance</i>"]
        CRO["<b>JooJoo</b><br/>CRO · Head of Customer Success<br/><i>Sales and support</i>"]
        CHRO["<b>Geeha</b><br/>CHRO · Head of Brand and Community<br/><i>People, hiring, marketing</i>"]
    end

    subgraph BUILD["Building the product"]
        direction TB
        ENG["<b>Reem</b><br/>Head of Engineering<br/><i>Full-stack developer</i>"]
        TEL["<b>Islam (Legacy)</b><br/>Head of Telephony<br/><i>Telecom engineer</i>"]
        DATA["<b>Omar</b><br/>Head of Data<br/><i>Data engineer</i>"]
        OPS["<b>Eslam</b><br/>Head of Infrastructure<br/><i>DevOps engineer</i>"]
        SEC["<b>Joe</b><br/>Head of Security<br/><i>Security engineer</i>"]
        QA["<b>Hussein</b><br/>QA Lead<br/><i>QA engineer (junior)</i>"]
    end

    subgraph OUTSIDE["From outside, when needed"]
        direction LR
        LAW["US lawyer"]
        PEN["Security tester"]
        DES["Designer"]
    end

    CEO --> COO & CFO & CPO & CRO & CHRO
    CEO --> ENG
    ENG --> TEL & DATA & OPS & SEC & QA

    COO -. "task board and follow-up" .-> BUILD
    CPO -. "specs and the API contract" .-> ENG
    CPO -. "works with" .-> LAW
    SEC -. "works with" .-> PEN
    ENG -. "works with" .-> DES

    classDef top fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef company fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef build fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    classDef outside fill:#f4f4f4,stroke:#9a9a9a,color:#333333,stroke-dasharray:4 3
    class CEO top
    class COO,CFO,CPO,CRO,CHRO company
    class ENG,TEL,DATA,OPS,SEC,QA build
    class LAW,PEN,DES outside
    style COMPANY fill:#f7faff,stroke:#5b8fc7,color:#10243d
    style BUILD fill:#f6fbf7,stroke:#5aa36f,color:#12301c
    style OUTSIDE fill:#fafafa,stroke:#b5b5b5,color:#333333
```

Solid lines are who reports to whom. Magdy runs the day-to-day work of both sides: he turns Mohammed's decisions into tasks, hands
them out and follows them up. Technical calls go up through Reem to Mohammed. Rana hands Reem the specs and the API contract to build from. The dotted lines to the outside are who works with
the lawyer, the security tester and a designer.

### Who decides what

Each lead decides inside their own area and tells Magdy. A decision goes up to Mohammed only when it touches the direction,
the architecture, the law, money above Malaa's limit, or what goes to production.

```mermaid
flowchart TB
    M["<b>Mohammed decides</b><br/>direction · architecture · anything legal<br/>money above Malaa's limit · what goes to production"]

    subgraph CO["Running the company: each decides in their area"]
        direction TB
        D1["<b>Magdy</b><br/>who takes which task,<br/>the weekly plan, release dates"]
        D2["<b>Malaa</b><br/>spending up to the limit,<br/>supplier terms"]
        D3["<b>Rana</b><br/>what a feature does (its spec),<br/>the API contract, which tool to pick"]
        D4["<b>JooJoo</b><br/>which customers first,<br/>support answers"]
        D5["<b>Geeha</b><br/>hiring shortlists,<br/>marketing and posts"]
    end

    subgraph PR["Building the product: each decides in their area"]
        direction TB
        D6["<b>Reem</b><br/>how code is written,<br/>review and merging"]
        D7["<b>Islam · Omar</b><br/>how their containers work"]
        D8["<b>Eslam</b><br/>servers, CI, backups"]
        D9["<b>Joe</b><br/>security rules;<br/>can stop a release"]
        D10["<b>Hussein</b><br/>a release passes or<br/>fails testing"]
    end

    D1 ~~~ D2 ~~~ D3 ~~~ D4 ~~~ D5
    D6 ~~~ D7 ~~~ D8 ~~~ D9 ~~~ D10
    M -- "brings the rest up to Mohammed" --- CO
    M -- "brings the rest up to Mohammed" --- PR

    classDef top fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef ceo fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef cto fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    class M top
    class D1,D2,D3,D4,D5 ceo
    class D6,D7,D8,D9,D10 cto
    style CO fill:#f7faff,stroke:#5b8fc7,color:#10243d
    style PR fill:#f6fbf7,stroke:#5aa36f,color:#12301c
```

### Who owns which containers

Every container, grouped by what it does, with its owner. Grey is parked. Joe reviews the security of the entry and accounts
group, and Hussein tests all of it.

```mermaid
flowchart LR
    O1["<b>Reem</b>"] --> A1["<b>Screens</b><br/>website · crm-web · crm (the app's screens)"]
    O2["<b>Mohammed</b><br/>Joe reviews"] --> A2["<b>Entry and accounts</b><br/>gateway · auth · authz · notifications"]
    O3["<b>Mohammed</b><br/>Reem learning Go"] --> A3["<b>CRM</b><br/>crm-core · crm-merge · crm-outbox · messaging"]
    O4["<b>Islam</b>"] --> A4["<b>Calls and texts</b><br/>six telnyx-* (dialer-sms until the switch)<br/>live (centrifugo)"]
    O5["<b>Omar</b>"] --> A5["<b>Data</b><br/>importing-lists · importing-worker<br/>learning · skip-engine"]
    O6["<b>Rana</b><br/>Mohammed writes the Go"] --> A6["<b>AI</b><br/>assistant · mcp"]
    O7["<b>Eslam</b>"] --> A7["<b>Running it</b><br/>grafana-proxy · alert-relay<br/>Grafana, Prometheus, Loki · databases and backups"]
    O8["<b>No owner yet</b>"] --> A8["<b>Parked</b><br/>billing · crm-desktop · lists-desktop<br/>mobile app (Geeha, later)"]

    classDef person fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef area fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    classDef none fill:#f4f4f4,stroke:#9a9a9a,color:#333333,stroke-dasharray:4 3
    class O1,O2,O3,O4,O5,O6,O7 person
    class A1,A2,A3,A4,A5,A6,A7 area
    class O8,A8 none
```

### Where each person is heading

```mermaid
flowchart LR
    R1["<b>Reem</b><br/>Head of Engineering"] --> R2["CTO"]
    A1["<b>Rana</b><br/>Product and Research Lead"] --> A2["CPO"]
    J1["<b>Joe</b><br/>Head of Security"] --> J2["CISO"]
    G1["<b>Geeha</b><br/>CHRO · Brand and Community"] --> G2["Head of Mobile (Flutter)"]
    H1["<b>Hussein</b><br/>QA Lead (junior)"] --> H2["QA Lead (automation)"]
    M1["<b>Mohammed</b><br/>CEO · CTO"] --> M2["CEO only"]

    classDef now fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef later fill:#fff4e0,stroke:#d49a2a,color:#3d2a05
    class R1,A1,J1,G1,H1,M1 now
    class R2,A2,J2,G2,H2,M2 later
```

## The people

### Running the company

| Person | Title now | Title later | Strength | Owns |
| --- | --- | --- | --- | --- |
| **Mohammed** | Founder · CEO · CTO | CEO (CTO passes to Reem) | Built everything so far | Direction, final decisions, architecture and the D-numbers, approving `production`, secrets in Coolify, the Go backend until Reem takes it |
| **Magdy** | Co-founder · COO and Chief of Staff | — | Carries out Mohammed's direction faithfully | The task board, weekly plan and status, chasing blockers, release checks, keeping `docs/plans/` and the decision list current, admin and contracts |
| **Malaa** | CFO and Head of US Operations | — | Finance; contacts in the US | Budget and runway, the US company, bank, taxes and accountant, Paddle and Stripe accounts, supplier deals, investors and partnerships |
| **Rana** | Product and Research Lead (and Compliance Lead) · technical product manager | CPO | Researches anything fast and precisely; fresh graduate who has taken in a great deal of technical material | Research before each decision, tool and supplier comparisons, competitors and pricing proposals, `docs/legal/research/`, the lawyer's questions; **technical:** the feature specs with their acceptance checks, the API contract (`contracts/api-v1.yaml`, `contracts/events.md`), the AI assistant's prompts, tools and tests (`assistant`, `mcp`; the Go with Mohammed), product numbers in SQL with Omar, the anti-cloning work with Joe |
| **JooJoo** | CRO and Head of Customer Success | — | Has dealt with customers the most | First agencies and beta testers, demos and sales, onboarding and support, customer feedback to Rana |
| **Geeha** | CHRO and Head of Brand and Community | Head of Mobile | Talks well, convinces, good with people; started with Dart | Hiring and onboarding, culture, marketing and social, events and demos with JooJoo; learns Flutter for the mobile app |

### Building the product

| Person | Title now | Title later | Role | Owns |
| --- | --- | --- | --- | --- |
| **Reem** | Head of Engineering | CTO | Full-stack developer (React, JavaScript, Python, SQL and NoSQL) | `apps/crm` (the CRM web app), `apps/website`; day-to-day code review; backup on `importing-*`; learns Go on `crm-core` |
| **Islam (Legacy)** | Head of Telephony | — | Telecom engineer (mobile core PS/CS) | `dialer-sms`, the six `telnyx-*` containers, `centrifugo`; carriers, numbers, 10DLC |
| **Omar** | Head of Data | — | Data engineer and analyst (Python) | `engines/skip-engine`, `importing-lists`, `importing-worker`, `learning`; numbers and reports for the business side |
| **Eslam** | Head of Infrastructure | — | DevOps engineer | Coolify and the VPS, CI and images, production branches, monitoring and `alert-relay`, backups, databases |
| **Joe** | Head of Security | CISO | Security engineer (CompTIA Network+ and Security+) | Security review of `gateway`, `auth`, `authz`, `grafana-proxy`; Cloudflare and firewall; secret changes; [security upkeep](../operations/security-upkeep.md) |
| **Hussein** | QA Lead (junior) | — | Studying software testing, manual first | [Checks by hand](../plans/people-teams-chats-clients/checks-by-hand.md), test cases per step, the sign-off before a release |

### From outside, when needed

| Who | For |
| --- | --- |
| A US lawyer | Terms, privacy, consent wording, calling and texting law ([what they are asked](../plans/people-teams-chats-clients/08-for-the-lawyer.md)) |
| An outside security tester | One test before opening to customers |
| A designer | The web rebuild, if the team's own design is not enough |

## Who decides what

The CEO's and CTO's work is shared out so that Mohammed decides and the others carry it out.

| Work | Owner |
| --- | --- |
| Direction, money above Malaa's limit, anything legal, architecture | **Mohammed** |
| Running the week: meetings, goals, who does what, status to Mohammed | **Magdy** |
| Engineering process: the task board, assigning tasks, release checks before `production` | **Magdy**, with Hussein's sign-off |
| Budget, runway, spending up to a limit Mohammed sets, the technology bill | **Malaa** |
| The US company, bank, taxes, payment accounts, investors | **Malaa** |
| What to build next and why; research for each decision, brought as options with a recommendation | **Rana** |
| Pricing: what each tier holds (Rana) and the margins (Malaa) | **Rana** + **Malaa** |
| Compliance: do not call, TCPA, 10DLC, privacy, working with the lawyer | **Rana** |
| Sales, onboarding, support, customer feedback | **JooJoo** |
| Hiring, onboarding, culture, marketing, the brand | **Geeha** |
| Code review and technical guidance | **Reem** (frontend, Python), **Joe** (security), **Eslam** (infrastructure) |
| Technology and supplier comparisons before building | **Rana** |
| Feature specs and acceptance checks; the API contract; the AI assistant's behaviour | **Rana**, with Reem (code) and Hussein (tests) |
| Protecting the app from being copied: the licence terms (with the lawyer) and the technical measures (with Joe) | **Rana** + **Joe** |
| Finding engineers; the technical interview | **Geeha**; **Reem** or **Mohammed** |

## Not covered yet

- **Go backend:** only Mohammed writes Go today, and about half the containers are Go. Reem learns it on small `crm-core` tasks.
- **Desktop app (Rust, Tauri):** parked until the web version is done. No owner.
- **Mobile app:** Geeha, once he has learned Flutter; until then not started.
- **Billing:** parked. When it starts, Reem builds it (Python), Malaa owns the accounts and Joe reviews it.
