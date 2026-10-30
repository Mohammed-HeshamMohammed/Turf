# Page 13 – Team (`#/team`)

Source: `src/Team.jsx`. Roles with the page: owner, manager. Read-only; every number is computed from other entities, nothing is stored.

## ER diagram

```mermaid
erDiagram
    PERSON ||--o{ LEAD : "active leads (not Closed)"
    PERSON ||--o{ TASK : "open steps"
    PERSON ||--o{ CALL : "calls logged (agent)"
    PERSON ||--o{ HANDOFF : "waiting (to, Requested)"
    LEAD ||--o| DEAL : "pipeline on their leads"
    ROLE ||--|| PERSON : "title and group"

    PERSON {
        string name PK "Maya Chen, Alex Rivera, Ben Carter, Lena Brooks"
        string role "from the first ROLE whose person matches"
        string group "ROLE.title"
    }
    ROLE {
        string id PK
        string name
        string title
        string person FK
    }
    LEAD {
        string id PK
        string assignee FK
        string stage
        bool archived
    }
    TASK {
        string id PK
        string assignee FK
        bool done
    }
    CALL {
        string id PK
        string leadId FK
        string agent FK
    }
    HANDOFF {
        string id PK
        string to FK
        string status
    }
    DEAL {
        string id PK
        string leadId FK
        string stage
        int amount
    }
```

## Metrics per person

| Card value | Calculation |
| --- | --- |
| Active leads | visible leads, stage ≠ Closed, `assignee` = person |
| Open steps | visible tasks, not done, `assignee` = person |
| Calls logged | `lead.calls` entries on visible leads where `agent` = person |
| Handoffs waiting | handoffs with `to` = person, status Requested, on a visible lead |
| Pipeline on their leads | sum of `deal.amount` for their active leads, stage not starting with "Closed". Shown only with `finance` |

Page-level tiles: People (4), Active leads (sum), Open next steps (sum), Unassigned (visible active leads with no assignee or "Unassigned"; links to `work/leads?assignee=Unassigned`).

Links out: See leads → `work/leads?assignee=:name`, See tasks → `work/tasks?assignee=:name`, Handoffs waiting → `work/handoffs`.
