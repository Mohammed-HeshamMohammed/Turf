# Page 09 – Calendar (`#/work/calendar`)

Source: `src/Work.jsx` (`Calendar`). A month grid (6 weeks, Monday first) of open tasks. Local UI state: month, year and selected day. Timezone label comes from workspace settings.

## ER diagram

```mermaid
erDiagram
    TASK }o--|| CALENDAR_DAY : "falls on (task.date)"
    LEAD ||--o{ TASK : "has next steps"
    PERSON ||--o{ TASK : "assignee"
    WORKSPACE_SETTINGS ||--|| CALENDAR_DAY : "timezone label"

    CALENDAR_DAY {
        string date PK "YYYY-MM-DD, computed not stored"
        bool isToday
        bool inMonth
    }
    TASK {
        string id PK
        string leadId FK
        string title
        string date FK
        string time
        string assignee FK
        bool done
    }
    LEAD {
        string id PK
        string name
        string address
    }
    PERSON {
        string name PK
    }
    WORKSPACE_SETTINGS {
        string timezone
    }
```

## UI → data

| Element | Data |
| --- | --- |
| Month grid cell | count of open `TASK` where `task.date` equals the cell date |
| Selected day panel | open tasks that day sorted by `task.time`: `title`, `time`, `assignee`, lead link |
| Complete button | `TASK {id}` toggles `done` |
| New task button | goes to [08-tasks.md](08-tasks.md) new-task form |
| Today button | resets to October 2026 and `TODAY` (2026-10-15) |
| Previous / next month | local state only |

The calendar has no event table of its own. Appointments are tasks of type Appointment.
