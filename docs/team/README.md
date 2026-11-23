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
        CPO["<b>Rana</b><br/>Product and Research Lead<br/><i>Research analyst · Compliance</i>"]
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
them out and follows them up. Technical calls go up through Reem to Mohammed. The dotted lines to the outside are who works with
the lawyer, the security tester and a designer.

### Who decides what

Mohammed decides; the work under the CEO and CTO titles is carried by the others.

```mermaid
flowchart TB
    M["<b>Mohammed</b><br/>direction · architecture<br/>money above the limit · legal<br/>approving production"]

    subgraph CEOWORK["The CEO's work"]
        direction TB
        W1["Running the week, goals, status<br/><b>Magdy</b>"]
        W2["Budget, US company, bank,<br/>payment accounts, investors<br/><b>Malaa</b>"]
        W3["What to build next, research,<br/>pricing, compliance<br/><b>Rana</b>"]
        W4["Sales, onboarding, support<br/><b>JooJoo</b>"]
        W5["Hiring, culture, marketing, brand<br/><b>Geeha</b>"]
    end

    subgraph CTOWORK["The CTO's work"]
        direction TB
        T1["Task board, release checks<br/><b>Magdy</b> with Hussein's sign-off"]
        T2["Code review, technical guidance<br/><b>Reem</b>"]
        T3["Infrastructure decisions<br/><b>Eslam</b>"]
        T4["Security decisions<br/><b>Joe</b>"]
        T5["Tool and supplier research<br/><b>Rana</b>"]
        T6["Technology bill<br/><b>Malaa</b>"]
    end

    W1 ~~~ W2 ~~~ W3 ~~~ W4 ~~~ W5
    T1 ~~~ T2 ~~~ T3 ~~~ T4 ~~~ T5 ~~~ T6
    M --> CEOWORK
    M --> CTOWORK

    classDef top fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef ceo fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef cto fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    class M top
    class W1,W2,W3,W4,W5 ceo
    class T1,T2,T3,T4,T5,T6 cto
    style CEOWORK fill:#f7faff,stroke:#5b8fc7,color:#10243d
    style CTOWORK fill:#f6fbf7,stroke:#5aa36f,color:#12301c
```

### Who owns which containers

```mermaid
flowchart LR
    MO["<b>Mohammed</b><br/>until Reem knows Go"] --> G1["crm-core · crm-merge · crm-outbox<br/>auth · authz · messaging<br/>assistant · mcp"]
    RE["<b>Reem</b>"] --> G2["apps/crm (CRM web app)<br/>apps/website"]
    IS["<b>Islam</b>"] --> G3["dialer-sms · six telnyx-*<br/>centrifugo (live)"]
    OM["<b>Omar</b>"] --> G4["skip-engine · importing-lists<br/>importing-worker · learning"]
    ES["<b>Eslam</b>"] --> G5["Coolify and the VPS · CI and images<br/>production branches · monitoring<br/>alert-relay · backups · databases"]
    JO["<b>Joe</b>"] --> G6["reviews gateway · auth · authz<br/>grafana-proxy · Cloudflare · secrets"]
    HU["<b>Hussein</b>"] --> G7["checks by hand · test cases<br/>release sign-off"]
    NO["<b>No owner yet</b>"] --> G8["billing (parked)<br/>desktop app (parked)<br/>mobile app (Geeha, later)"]

    classDef person fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef owned fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    classDef none fill:#f4f4f4,stroke:#9a9a9a,color:#333333,stroke-dasharray:4 3
    class MO,RE,IS,OM,ES,JO,HU person
    class G1,G2,G3,G4,G5,G6,G7 owned
    class NO,G8 none
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
| **Rana** | Product and Research Lead (and Compliance Lead) | CPO | Researches anything fast and precisely; fresh graduate | Research before each decision, tool and supplier comparisons, competitors and pricing proposals, `docs/legal/research/`, the lawyer's questions |
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
| Finding engineers; the technical interview | **Geeha**; **Reem** or **Mohammed** |

## Not covered yet

- **Go backend:** only Mohammed writes Go today, and about half the containers are Go. Reem learns it on small `crm-core` tasks.
- **Desktop app (Rust, Tauri):** parked until the web version is done. No owner.
- **Mobile app:** Geeha, once he has learned Flutter; until then not started.
- **Billing:** parked. When it starts, Reem builds it (Python), Malaa owns the accounts and Joe reviews it.
