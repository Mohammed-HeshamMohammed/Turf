# Page 14 – Reports (`#/reports`)

Source: `src/Management.jsx` (`Reports`). Roles with the page: owner, manager, closer, researcher, client, solo. All figures are computed from the records the person can see. The period selector ("This week", "This month", "All time") is a layout preview; totals always show the current snapshot.

## ER diagram

```mermaid
erDiagram
    LEAD ||--o| DEAL : "Deals column"
    LEAD }o--|| SOURCE_GROUP : "grouped by source (client: by city)"
    LEAD }o--|| LEAD_STAGE : "Lead progression"
    LEAD ||--o{ TASK : "open and completed steps"
    ROLE ||--o{ REPORT_SCHEDULE : "created by"

    SOURCE_GROUP {
        string source PK "Absentee owners, County records, CSV import; for client the city"
        int count "visible leads"
        int ready "verdict Ready to call"
        int qualified "stage Qualified"
        int deals "deals on those leads"
        int share "percent of visible leads"
    }
    LEAD {
        string id PK
        string source
        string city
        string stage FK
        string verdict
    }
    LEAD_STAGE {
        string name PK "New Contacted Interested Qualified Closed"
    }
    DEAL {
        string id PK
        string leadId FK
        int amount
    }
    TASK {
        string id PK
        bool done
    }
    REPORT_SCHEDULE {
        string email
        string frequency "Weekly on Monday, Monthly on the first"
        string role FK
        string range
    }
    ROLE {
        string id PK
        string scope
    }
```

`SOURCE_GROUP` is computed, not stored. `REPORT_SCHEDULE` is saved in state (`reportSchedules`), is local only, and sends nothing.

## Blocks → data

| Block | Calculation | Visible to |
| --- | --- | --- |
| Metric tiles | Visible leads (client: "Shared properties"), Qualified, Open next steps, Recorded pipeline = sum of `deal.amount` (without `finance`: Completed next steps) | all |
| Source effectiveness table | per source: count, Ready to call (hidden for client), Qualified, Deals (needs `finance`), share meter | all (client sees "Shared property locations" by city) |
| Export CSV | same rows | `export` capability |
| Lead progression | count and meter per `LEAD_STAGE` | all |
| Scheduled reports / What this report includes | `reportSchedules` list; others see a text about scope | `finance` sees the list |
| Schedule report modal | Recipient email, Frequency | `REPORT_SCHEDULE`, `finance` |
| Print / save PDF | `window.print()` | all |
