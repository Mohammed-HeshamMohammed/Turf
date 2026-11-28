# How the work flows

What Rana, Reem and Magdy each do, and how a feature passes between them. Who owns what is on the [team page](README.md);
the work waiting to be taken is in [tasks/](tasks/README.md).

In one line: **Rana says what to build, Magdy gets it built, Reem builds it**, and Mohammed makes the final calls.

## A feature from idea to customer

```mermaid
sequenceDiagram
    autonumber
    participant C as Customer
    participant J as JooJoo
    participant R as Rana
    participant MO as Mohammed
    participant MA as Magdy
    participant RE as Reem
    participant QA as Joe and Hussein

    C->>J: asks for something, or reports a problem
    J->>R: passes it on, with how many customers ask
    R->>R: researches it: options, cost, law, how others do it
    R->>MO: brings the options with a recommendation
    MO-->>R: decides
    R->>MA: the spec: what it does, the screens, the API, the checks
    MA->>RE: puts it on the task board and assigns it
    RE->>RE: builds it on a branch, opens a pull request
    RE->>QA: security review (Joe), checks by hand (Hussein)
    QA-->>MA: passed, or sent back with what failed
    MA->>MO: release check done, asks to go to production
    MO-->>MA: approves production
    MA->>J: it is live
    J->>C: tells the customer
```

Steps 3 to 5 are Rana's, 6 and 7 and 10 to 12 are Magdy's, 8 is Reem's. When anything is unclear, the question goes back
one step, not straight to Mohammed.

## Rana: what to build, and why

Rana turns questions into decisions and decisions into specs. She does not write the product's code, but she writes everything
the code is built from, and she owns how the AI assistant behaves.

```mermaid
flowchart TB
    I["<b>What comes in</b><br/>customer requests from JooJoo · Mohammed's questions<br/>laws and carrier rules · competitors and tools"]
    I --> W1["<b>Research</b><br/>facts, each with its source"]
    W1 --> W2["<b>Options</b><br/>each with cost, risk and a recommendation"]
    W2 --> O1["<b>Mohammed decides</b>"]
    O1 --> W3["<b>The spec</b><br/>the screens, the API,<br/>the checks that say it is done"]
    W3 --> O2["A task on<br/>Magdy's board"]
    W3 --> O3["An entry in<br/>contracts/api-v1.yaml"]
    W3 --> O4["Test cases<br/>for Hussein"]

    classDef in fill:#fff4e0,stroke:#d49a2a,color:#3d2a05
    classDef work fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef top fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef out fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    class I in
    class W1,W2,W3 work
    class O1 top
    class O2,O3,O4 out
```

### Rana and the AI assistant

Every change to the assistant's prompts or tools is tested before it ships, so it never gets worse without anyone noticing.

```mermaid
flowchart LR
    A["A change to a prompt<br/>or an MCP tool"] --> B["Run the test set:<br/>real questions with<br/>the right answers"]
    B --> C{"Better or<br/>the same?"}
    C -- "yes" --> D["Pull request;<br/>Mohammed merges the Go"]
    C -- "no" --> E["Change it again,<br/>or drop it"]
    E --> A
    D --> F["Cost per answer<br/>sent to Malaa"]

    classDef step fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef good fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    classDef bad fill:#fdecec,stroke:#c75b5b,color:#3d1010
    class A,B,C step
    class D,F good
    class E bad
```

| Rana does | Rana does not |
| --- | --- |
| Research, options and a recommendation for each decision | Make the final call (Mohammed does) |
| Specs with acceptance checks; the API contract | Write the product's screens or services |
| The assistant's prompts, tools and test set | Merge Go code |
| Compliance research and the lawyer's questions | Give legal advice; the lawyer words it |
| Product numbers in SQL, with Omar | Run the servers |

## Reem: building it

Reem builds the screens (`apps/crm`, `apps/crm-web`, `apps/website`), reviews other people's web code, and learns Go on small
`crm-core` tasks. Every change she makes follows the same road to `main` (see [AGENTS.md](../../AGENTS.md)).

```mermaid
flowchart TB
    T["Takes a task from<br/>Magdy's board"] --> S["Reads Rana's spec<br/>and the API contract"]
    S --> Q{"Is anything<br/>unclear?"}
    Q -- "yes" --> R["Asks Rana<br/>(what it should do)"]
    R --> S
    Q -- "no" --> B["Builds it on a branch,<br/>with tests"]
    B --> P["Opens a pull request"]
    P --> CI{"CI summary<br/>passes?"}
    CI -- "no" --> B
    CI -- "yes" --> V["Reviewed: Joe if it touches<br/>sign-in or security,<br/>Mohammed if it touches Go"]
    V --> M["Merged into main"]
    M --> H["Hussein checks it by hand"]
    H --> D["Magdy marks the task done"]

    classDef step fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    classDef ask fill:#fff4e0,stroke:#d49a2a,color:#3d2a05
    class T,S,B,P,V,M,H,D step
    class Q,CI,R ask
```

### Reem's road to more

```mermaid
flowchart LR
    N1["<b>Now</b><br/>web screens<br/>web code review"] --> N2["<b>Next</b><br/>small crm-core tasks in Go<br/>the Python importers with Omar"]
    N2 --> N3["<b>Later</b><br/>owns parts of the backend<br/>CTO candidate"]

    classDef now fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef later fill:#fff4e0,stroke:#d49a2a,color:#3d2a05
    class N1 now
    class N2,N3 later
```

| Reem does | Reem does not |
| --- | --- |
| Builds the screens and the website | Decide what a feature does (Rana's spec does) |
| Reviews web and Python pull requests | Approve production (Mohammed does) |
| Learns Go on small `crm-core` tasks | Change Go services alone yet; Mohammed reviews |
| Says how long a task will take | Pick her own tasks; Magdy assigns them |

## Magdy: getting it built

Magdy runs the week. He turns Mohammed's goals into tasks, gives them out, keeps them moving, and is the first stop for any
question. Until a CTO is chosen he also leads the engineers day to day.

```mermaid
flowchart LR
    subgraph WEEK["Every week"]
        direction TB
        W1["<b>Start of week</b><br/>goals from Mohammed,<br/>tasks picked from the lists"] --> W2["<b>Assign</b><br/>each person their tasks,<br/>small ones in the trial"]
        W2 --> W3["<b>Every day</b><br/>what moved, what is stuck,<br/>unblock it"]
        W3 --> W4["<b>End of week</b><br/>status to Mohammed:<br/>done, late, risks"]
    end
    W4 -- "next week" --> W1

    classDef step fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    class W1,W2,W3,W4 step
    style WEEK fill:#f7faff,stroke:#5b8fc7
```

### Where a question goes

Most questions stop with Magdy or a lead. Only the five things on the team page go to Mohammed.

```mermaid
flowchart TB
    Q["A question or a problem"] --> MA["<b>Magdy</b>"]
    MA --> A{"Whose area<br/>is it?"}
    A -- "one lead's area" --> L["That lead decides<br/>and tells Magdy"]
    A -- "what to build" --> R["Rana researches it<br/>and writes the spec"]
    A -- "money" --> ML{"Above Malaa's<br/>limit?"}
    ML -- "no" --> MAL["Malaa decides"]
    ML -- "yes" --> MO
    A -- "direction, architecture,<br/>law, production" --> MO["<b>Mohammed</b> decides"]

    classDef top fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    classDef mid fill:#e8f1fb,stroke:#5b8fc7,color:#10243d
    classDef lead fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    class MO top
    class MA,A,ML mid
    class L,R,MAL lead
```

### Before anything goes to production

```mermaid
flowchart LR
    C1["CI summary passed<br/>on main"] --> C2["Hussein's checks<br/>by hand passed"]
    C2 --> C3["Joe: no security<br/>objection"]
    C3 --> C4["Magdy asks<br/>Mohammed"]
    C4 --> C5["Mohammed approves<br/>production in GitHub"]
    C5 --> C6["JooJoo tells<br/>the customers"]

    classDef step fill:#eaf6ee,stroke:#5aa36f,color:#12301c
    classDef top fill:#1f3a5f,stroke:#1f3a5f,color:#ffffff
    class C1,C2,C3,C4,C6 step
    class C5 top
```

| Magdy does | Magdy does not |
| --- | --- |
| The task board, the weekly plan and the status | Decide direction or architecture |
| Assigns tasks and follows them up | Approve production (he asks Mohammed) |
| Leads the engineers day to day until a CTO is chosen | Override a lead inside their own area |
| Release checks before asking for production | Skip Hussein's or Joe's checks |
| Keeps `docs/plans/` and the decision list current | Write the specs (Rana does) |
| Backup on customer support | |
