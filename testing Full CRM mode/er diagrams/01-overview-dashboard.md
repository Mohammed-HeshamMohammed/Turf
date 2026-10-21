# Page 01 – Overview (`#/dashboard`)

Source: `src/Dashboard.jsx`, `src/CallActivityChart.jsx`. Every role has this page. The content changes by role: admin gets an access/services overview, client gets approved updates, everyone else gets "Needs you today", metrics, team activity and lead stages.

## ER diagram

```mermaid
erDiagram
    ROLE ||--|| PERSON : "is played by"
    PERSON ||--o{ LEAD : "owns"
    LEAD ||--o{ TASK : "due today"
    LEAD ||--o{ HANDOFF : "waiting to accept"
    LEAD ||--o{ THREAD : "unread messages"
    LEAD ||--o| DEAL : "pipeline"
    LEAD ||--o{ ACTIVITY : "team activity feed"
    LEAD }o--|| LEAD_STAGE : "stage tiles"
    CALL_TREND_POINT }o--|| CALL_DAY : "belongs to"
    INTEGRATION }o--|| ROLE : "counted for admin"

    ROLE {
        string id PK
        string name
        string scope
        string pages
    }
    PERSON {
        string name PK
    }
    LEAD {
        string id PK
        string name
        string address
        string stage FK
        string assignee FK
        string callback
        string callbackDate
        int value
        bool archived
    }
    LEAD_STAGE {
        string name PK
    }
    TASK {
        string id PK
        string leadId FK
        string title
        string date
        string time
        bool done
    }
    HANDOFF {
        string id PK
        string leadId FK
        string status
        string to FK
    }
    THREAD {
        string id PK
        string leadId FK
        string channel
        bool unread
    }
    DEAL {
        string id PK
        string leadId FK
        string stage
        int amount
    }
    ACTIVITY {
        string id PK
        string leadId FK
        string actor
        string text
        string time
        string kind
    }
    CALL_DAY {
        string day PK "Thu to Wed"
        string date
    }
    CALL_TREND_POINT {
        string day FK
        int slot
        string time "2-hour interval"
        int calls
        int reached
    }
    INTEGRATION {
        string name PK
        bool connected
    }
```

## What each block shows

| Block | Entities | Fields used | Action |
| --- | --- | --- | --- |
| Needs you today | `TASK`, `LEAD`, `HANDOFF`, `THREAD` | `task.date/time/title`, `lead.callback`, `handoff.status`, `thread.unread` | opens lead, handoffs or inbox |
| Metrics (not admin) | `LEAD`, `TASK`, `DEAL` | counts by stage, open tasks, `deal.amount` (finance capability only) | – |
| Call activity chart | `CALL_TREND_POINT` (constant `CALL_TREND`, 42 points) | `day`, `time`, `calls`, `reached` | hover / keyboard |
| Lead stages | `LEAD`, `LEAD_STAGE` | count per stage | `work/leads?stage=` |
| Team activity | `ACTIVITY` | `actor`, `text`, `time`, `kind` | opens lead |
| Client "Approved updates" | `LEAD` (shared), `NOTE` (shared) | shared notes | opens lead |
| Admin overview | `INTEGRATION`, `ROLE` | connected count, 8 role presets, 6 services | settings links |

`CALL_TREND_POINT` is illustrative constant data, not stored in state.
