# The team

Who is on Caller Whale, what each person owns, and who decides what. The work waiting to be done is in [tasks/](tasks/README.md),
grouped by area and **not assigned to anyone yet**. How a feature passes from Rana to Magdy to Reem, with their work drawn step by step, is in
[how-the-work-flows.md](how-the-work-flows.md).

Written 2026-11-24, from Mohammed's answers. Titles marked *later* are what a person grows into.

## Where we are

- **The goal:** finish version 1 and get the customers who are already waiting onto it. Everything else comes after.
- **So far only Mohammed and Magdy have built Caller Whale.** The team was gathered so the work is shared and the two of them
  can step back from doing everything.
- **Pay:** nobody is paid yet. Pay starts once Caller Whale has earned EGP 50,000, so it runs itself instead of on debt.
- **A trial first:** everyone starts with 2 to 4 weeks of small tasks. Ownership and titles below are confirmed after it.
- **Titles are shared out.** Mohammed keeps one C-title (CEO), so the titles and the weight that comes with them are spread
  fairly across the team.
- **The CTO is chosen after version 1**, by results. Reem and Rana both get real technical ownership; Mohammed picks. Until then
  Magdy, as co-founder and COO, leads the engineering work day to day and brings the final calls to Mohammed.

## The diagrams

### Who reports to whom

```mermaid
flowchart TB
    CEO["<b>Mohammed</b><br/>Founder · CEO<br/><i>Writes the Go backend for now</i>"]

    subgraph COMPANY["Running the company"]
        direction TB
        COO["<b>Magdy</b><br/>Co-founder · COO<br/><i>Leads engineering until a CTO is chosen</i>"]
        CFO["<b>Malaa</b><br/>CFO · Head of Mobile Network<br/><i>Finance · the US company · carriers</i>"]
        CPO["<b>Rana</b><br/>CPO<br/><i>Product · specs · AI · compliance</i>"]
        CRO["<b>JooJoo</b><br/>CRO<br/><i>Sales · customers · support</i>"]
        CHRO["<b>Geeha</b><br/>CHRO (light)<br/><i>People · and the mobile app</i>"]
    end

    subgraph BUILD["Building the product"]
        direction TB
        ENG["<b>Reem</b><br/>Lead Developer · CTO candidate<br/><i>Full-stack (React, Python, SQL)</i>"]
        TEL["<b>Islam (Legacy)</b><br/>Telephony and Network Engineer<br/><i>Carriers, SIP, VoIP</i>"]
        DATA["<b>Omar</b><br/>Head of Data<br/><i>Data analysis</i>"]
        OPS["<b>Eslam</b><br/>Head of Infrastructure<br/><i>Docker, Linux servers</i>"]
        SEC["<b>Joe</b><br/>Head of Security<br/><i>Network, testing, code review</i>"]
        QA["<b>Hussein</b><br/>QA (junior)<br/><i>Checks before releases</i>"]
    end

    CEO --> COO & CFO & CPO & CRO & CHRO
    COO == "leads" ==> BUILD

    CPO -. "specs · API · AI" .-> BUILD
    CHRO -. "mobile app" .-> BUILD
    CFO -. "leads the mobile network" .-> TEL

    classDef top fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef company fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef build fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    class CEO top
    class COO,CFO,CPO,CRO,CHRO company
    class ENG,TEL,DATA,OPS,SEC,QA build
    style COMPANY fill:#f7faff,stroke:#5b8fc7,color:#10243d
    style BUILD fill:#f6fbf7,stroke:#5aa36f,color:#12301c
```

The five company leads report to Mohammed. The engineers report to Magdy day to day until a CTO is chosen; their technical
questions go through him to Mohammed (the thick line). The outside help (lawyer, security tester, designer) is in the
table below. Rana, Geeha and Malaa sit on the company side but also build: Rana the specs, the API contract
and the AI assistant, Geeha the mobile app, and Malaa leads the mobile network, with Islam doing the hands-on setup.

### Who decides what

Each lead decides inside their own area and tells Magdy. A decision goes up to Mohammed only when it touches the direction,
the architecture, the law, money above Malaa's limit, or what goes to production.

```mermaid
flowchart TB
    M["<b>Mohammed decides</b><br/>direction · architecture · anything legal<br/>money above Malaa's limit · what goes to production"]

    subgraph CO["Running the company: each decides in their area"]
        direction TB
        D1["<b>Magdy</b><br/>who takes which task, the weekly plan,<br/>release dates, day-to-day engineering calls"]
        D2["<b>Malaa</b><br/>spending up to the limit, supplier terms,<br/>carriers and the mobile network"]
        D3["<b>Rana</b><br/>what a feature does (its spec),<br/>the API contract, which tool to pick"]
        D4["<b>JooJoo</b><br/>which customers first,<br/>support answers"]
        D5["<b>Geeha</b><br/>onboarding new people,<br/>how the mobile app is built"]
    end

    subgraph PR["Building the product: each decides in their area"]
        direction TB
        D6["<b>Reem</b><br/>how the web code is written,<br/>review and merging"]
        D7["<b>Islam</b><br/>the numbers and SIP setup,<br/>under Malaa"]
        D8["<b>Omar</b><br/>which data sources to use,<br/>and if they are good enough"]
        D9["<b>Eslam</b><br/>servers, CI, backups"]
        D10["<b>Joe</b><br/>security rules;<br/>can stop a release"]
        D11["<b>Hussein</b><br/>a release passes or<br/>fails testing"]
    end

    D1 ~~~ D2 ~~~ D3 ~~~ D4 ~~~ D5
    D6 ~~~ D7 ~~~ D8 ~~~ D9 ~~~ D10 ~~~ D11
    M -- "brings the rest up to Mohammed" --- CO
    M -- "brings the rest up to Mohammed" --- PR

    classDef top fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef ceo fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef cto fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    class M top
    class D1,D2,D3,D4,D5 ceo
    class D6,D7,D8,D9,D10,D11 cto
    style CO fill:#f7faff,stroke:#5b8fc7,color:#10243d
    style PR fill:#f6fbf7,stroke:#5aa36f,color:#12301c
```

### Who owns which containers

Every container, grouped by what it does. Where someone is still learning the code, the person writing it for now is named
too. Joe reviews the security of all of it, and Hussein tests it before a release.

```mermaid
flowchart LR
    O1["<b>Reem</b>"] --> A1["<b>Screens</b><br/>website · crm-web · crm (the app's screens)"]
    O2["<b>Mohammed</b><br/>Joe reviews"] --> A2["<b>Entry and accounts</b><br/>gateway · auth · authz · notifications"]
    O3["<b>Mohammed</b><br/>Reem learning Go"] --> A3["<b>CRM</b><br/>crm-core · crm-merge · crm-outbox · messaging"]
    O4["<b>Malaa</b>: leads the mobile network<br/><b>Islam</b>: numbers, SIP setup<br/><b>Mohammed</b>: the Go code"] --> A4["<b>Calls and texts</b><br/>six telnyx-* (dialer-sms until the switch)<br/>live (centrifugo)"]
    O5["<b>Omar</b>: the data and its quality<br/><b>Mohammed, Reem</b>: the code for now"] --> A5["<b>Data</b><br/>importing-lists · importing-worker<br/>learning · skip-engine"]
    O6["<b>Rana</b>: prompts, tools, tests<br/><b>Mohammed</b>: the Go code"] --> A6["<b>AI</b><br/>assistant · mcp"]
    O7["<b>Eslam</b><br/>Islam helps on the network"] --> A7["<b>Running it</b><br/>grafana-proxy · alert-relay<br/>Grafana, Prometheus, Loki · databases and backups"]
    O8["<b>Geeha</b><br/>learning Flutter"] --> A8["<b>Mobile app</b><br/>not started"]
    O9["<b>No owner yet</b>"] --> A9["<b>Parked</b><br/>billing · crm-desktop · lists-desktop"]

    classDef person fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef area fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    classDef none fill:#f4f4f4,stroke:#9a9a9a,color:#333333,stroke-dasharray:4 3
    class O1,O2,O3,O4,O5,O6,O7,O8 person
    class A1,A2,A3,A4,A5,A6,A7,A8 area
    class O9,A9 none
```

### Who answers the customers

The first customers are in the US, so someone covers US daytime (evening and night in Egypt).

```mermaid
flowchart LR
    C["<b>A customer</b><br/>question or problem"] --> J["<b>JooJoo</b><br/>first answer, onboarding"]
    J -- "a bug or how it works" --> MO["<b>Mohammed</b><br/>technical problems"]
    J -- "she is away" --> MA["<b>Magdy</b><br/>backup"]
    J -- "the service is down" --> E["<b>Eslam</b><br/>on call for the servers"]
    J -- "what they ask for" --> R["<b>Rana</b><br/>feedback into the specs"]

    classDef cust fill:#fff4e0,stroke:#d49a2a,color:#3d2a05
    classDef first fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef next fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    class C cust
    class J first
    class MO,MA,E,R next
```

### Where each person is heading

```mermaid
flowchart LR
    R1["<b>Reem</b><br/>Lead Developer"] --> CTO["<b>CTO</b><br/>chosen by Mohammed<br/>after version 1, by results"]
    A1["<b>Rana</b><br/>CPO"] --> CTO
    I1["<b>Islam</b><br/>Telephony and Network Engineer"] --> I2["Head of Telephony<br/>(SIP and VoIP)"]
    O1["<b>Omar</b><br/>Head of Data"] --> O2["Builds the data engines<br/>(skip engine, imports)"]
    J1["<b>Joe</b><br/>Head of Security"] --> J2["CISO"]
    G1["<b>Geeha</b><br/>CHRO (light)"] --> G2["Head of Mobile (Flutter)"]
    H1["<b>Hussein</b><br/>QA (junior)"] --> H2["QA Lead (automation)"]

    classDef now fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef later fill:#fff4e0,stroke:#d49a2a,color:#3d2a05
    class R1,A1,I1,O1,J1,G1,H1 now
    class CTO,I2,O2,J2,G2,H2 later
```

Rana and Reem both have a road to CTO: Reem through the code she ships, Rana through the specs, the API contract and the AI
work. Whoever is not chosen keeps their title (Rana stays CPO; Reem leads the web code).

## The people

### Running the company

| Person | Title now | Title later | Strength | Owns |
| --- | --- | --- | --- | --- |
| **Mohammed** | Founder · CEO | — | Built everything so far | Direction, final decisions, architecture and the D-numbers, approving `production`, secrets in Coolify, the Go backend until others take it, technical help for customers |
| **Magdy** | Co-founder · COO | — | With Mohammed from the start; understands the system, follows pull requests, builds with AI and reviews | The task board, weekly plan and status, leading engineering day to day until a CTO is chosen, release checks, `docs/plans/` and the decision list, admin and contracts, backup on customer support |
| **Malaa** | CFO · Head of Mobile Network | — | Thinks well about money; contacts in the US (he lives in Egypt); knows mobile networks best on the team | Budget and runway, registering and running the US company through his contacts, bank, taxes and accountant, Paddle and Stripe accounts, supplier deals, investors; **mobile network:** carriers, numbers, SIP trunks and 10DLC, leading Islam |
| **Rana** | CPO | CTO candidate | Finds answers fast and precisely, often before being asked; studied mobile networks, Python and some machine learning | Research before each decision, compliance and the lawyer's questions, `docs/legal/research/`; **technical:** feature specs with their acceptance checks, the API contract (`contracts/`), the AI assistant's prompts, tools and tests, product numbers in SQL with Omar, anti-cloning with Joe |
| **JooJoo** | CRO | — | Has dealt with US, foreign and Egyptian customers; good English | The waiting customers first, demos and sales, onboarding, first-line support on US hours, customer feedback to Rana |
| **Geeha** | CHRO (light) | Head of Mobile | Good with people; started with Dart | Mainly: learning Flutter and building the mobile app. On the side: onboarding new people and the team's mood |

### Building the product

| Person | Title now | Title later | Strength | Owns |
| --- | --- | --- | --- | --- |
| **Reem** | Lead Developer | CTO candidate | Full-stack, junior (React, JavaScript, Python, SQL and NoSQL) | `apps/crm`, `apps/crm-web`, `apps/website`; review of web code; learns Go on small `crm-core` tasks; helps on the Python importers |
| **Islam (Legacy)** | Telephony and Network Engineer | Head of Telephony | CCNA, CCNP, mobile networks, works in DevOps; does not code yet | Under Malaa: Telnyx setup, numbers, SIP trunks and 10DLC by hand; studies core PS, SIP and VoIP; helps Eslam with networking. The Go code of `telnyx-*` stays with Mohammed |
| **Omar** | Head of Data | — | Analyses large real-world data of the kind our customers use | Which data sources the skip engine and imports should use and how good they are; numbers and reports; grows into building `engines/skip-engine` and the importers |
| **Eslam** | Head of Infrastructure | — | Has run Docker and Linux servers | Coolify and the VPS, CI and images, production branches, monitoring and `alert-relay`, backups, databases; on call when a server breaks |
| **Joe** | Head of Security | CISO | Network security, hands-on testing and code review (CompTIA Network+ and Security+) | Security review of pull requests that touch `gateway`, `auth`, `authz`, `grafana-proxy`; Cloudflare and firewall; secret changes; [security upkeep](../operations/security-upkeep.md); anti-cloning with Rana |
| **Hussein** | QA (junior) | QA Lead (automation) | Studying software testing; a few hours a week | [Checks by hand](../plans/people-teams-chats-clients/checks-by-hand.md) before each release, and the sign-off |

### From outside, when needed

| Who | For |
| --- | --- |
| A US lawyer | Terms, privacy, consent wording, calling and texting law ([what they are asked](../plans/people-teams-chats-clients/08-for-the-lawyer.md)) |
| An outside security tester | One test before opening to customers |
| A designer | The web rebuild, if the team's own design is not enough |

## Who decides what

| Work | Owner |
| --- | --- |
| Direction, money above Malaa's limit, anything legal, architecture, what goes to production | **Mohammed** |
| Running the week: meetings, goals, who does what, status to Mohammed | **Magdy** |
| Engineering day to day until a CTO is chosen: assigning tasks, unblocking, release checks | **Magdy**, with Hussein's sign-off |
| Budget, runway, spending up to a limit Mohammed sets, the technology bill | **Malaa** |
| The US company, bank, taxes, payment accounts, investors | **Malaa** |
| What to build next and why; research for each decision, brought as options with a recommendation | **Rana** |
| Feature specs and acceptance checks; the API contract; the AI assistant's behaviour | **Rana**, with Reem (code) and Hussein (tests) |
| Pricing: what each tier holds (Rana) and the margins (Malaa) | **Rana** + **Malaa** |
| Compliance: do not call, TCPA, 10DLC, privacy, working with the lawyer | **Rana** |
| Protecting the app from being copied: the licence terms (with the lawyer) and the technical measures | **Rana** + **Joe** |
| Sales, onboarding, support, customer feedback | **JooJoo** |
| Onboarding new people, the team's mood | **Geeha** |
| Code review and technical guidance | **Reem** (web, Python), **Joe** (security), **Eslam** (infrastructure), **Mohammed** (Go) |
| Carriers, numbers, SIP trunks, 10DLC: the mobile network | **Malaa**, with Islam doing the setup |
| The CTO choice, after version 1 | **Mohammed** |

## Not covered yet

- **Go backend:** only Mohammed writes Go today, and about half the containers are Go. Reem learns it on small `crm-core` tasks.
- **The Python importers and the skip engine:** written by Mohammed; Reem helps now, Omar takes them over as he starts building.
- **Telnyx code:** Malaa leads the mobile network and Islam does the setup, but neither codes yet, so the `telnyx-*` code stays with Mohammed.
- **Desktop app (Rust, Tauri):** parked until the web version is done. No owner.
- **Billing:** parked. When it starts, Reem builds it (Python), Malaa owns the accounts and Joe reviews it.
