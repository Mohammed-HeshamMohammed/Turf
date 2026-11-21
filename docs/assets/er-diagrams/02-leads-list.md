# Page 02 – Leads list (`#/work/leads`)

Source: `src/Leads.jsx` (`Leads`), `src/PropertyMap.jsx`. Views: **List**, **Board** (not for client) and **Map**. Filters: search text, stage (`?stage=`), assigned person (`?assignee=`), "hide empty", and show archived.

## ER diagram

```mermaid
erDiagram
    ROLE ||--o{ LEAD : "scopes which leads are visible"
    PERSON ||--o{ LEAD : "assignee filter"
    DATASET ||--o{ LEAD : "supplied"
    LEAD }o--|| LEAD_STAGE : "board column"
    LEAD ||--o{ ACTIVITY : "logs stage and assignment changes"
    LEAD ||--o{ SYNC_QUEUE_ITEM : "queues change when offline"
    LEAD ||--o{ TASK : "next step badge"

    LEAD {
        string id PK
        string name
        string address
        string city
        string region
        string zip
        float latitude "map pin when supplied"
        float longitude "map pin when supplied"
        string phone
        string email
        string stage FK
        string assignee FK
        string team
        string datasetId FK
        string verdict "status badge"
        string callback "next callback"
        string callbackDate
        string priority
        bool shared
        bool archived
        int version
    }
    LEAD_STAGE {
        string name PK "New Contacted Interested Qualified Closed"
    }
    PERSON {
        string name PK "Maya Chen Alex Rivera Ben Carter Lena Brooks Unassigned"
    }
    ROLE {
        string id PK
        string team
        string capabilities
    }
    DATASET {
        string id PK
        string name
    }
    ACTIVITY {
        string id PK
        string leadId FK
        string text
        string kind
    }
    TASK {
        string id PK
        string leadId FK
        bool done
    }
    SYNC_QUEUE_ITEM {
        string id PK
        string leadId FK
        string label
        string kind "Lead update"
        string status
    }
```

## UI controls → data

| Control | Reads | Writes (reducer action) |
| --- | --- | --- |
| Search box | `lead.name/address/city/phone/email` | – |
| Stage filter, assignee filter | `lead.stage`, `lead.assignee` | – |
| Show archived | `lead.archived` | – |
| Stage drag on Board / keyboard stage change | `lead.stage` | `UPDATE_LEAD {change:{stage}}` → `lead.version+1`, new `ACTIVITY` |
| Bulk stage select | selected `lead.id` list | `UPDATE_LEAD` per lead |
| Bulk assign | `lead.assignee` | `UPDATE_LEAD {change:{assignee}}` (needs `assign` capability and being online) |
| Map view | `lead.latitude/longitude`, `address` (approximate area if no coordinates) | – |
| "New lead" button | – | navigates to [04-new-lead.md](04-new-lead.md) |
| Row click | – | opens [03-lead-detail.md](03-lead-detail.md) |

Visibility rule (`scopedLeads`): owner and solo see all; manager and researcher see their team; caller and closer see leads they are assigned or have an incoming handoff for; client sees `shared` leads only; admin sees none.
