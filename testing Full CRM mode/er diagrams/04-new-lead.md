# Page 04 – New lead (`#/work/leads/new`)

Source: `src/Leads.jsx` (`NewLead`). Needs the `edit` capability. One form, one new `LEAD`.

## ER diagram

```mermaid
erDiagram
    PERSON ||--o{ LEAD : "Responsible person"
    DATASET ||--o{ LEAD : "filed under d04 New leads October"
    LEAD ||--o{ SYNC_QUEUE_ITEM : "New lead when offline"
    LEAD }o--|| LEAD_STAGE : "starts as New"

    LEAD {
        string id PK "generated"
        string name "Property owner"
        string address "Property address"
        string city
        string region "State or region"
        string country
        string unit "Unit or address line 2"
        string zip "ZIP code"
        float latitude
        float longitude
        string phone
        string email
        string assignee FK "Responsible person"
        string callback "Callback time"
        int value "Estimated property value"
        string motivation "What do we know so far"
        string stage "New"
        string callbackDate "today when a time is given"
        string source "Added manually"
        string team "creator's team, else Tampa"
        string datasetId FK "d04"
        string verdict "Unverified"
        string priority "Normal"
        int version "1"
    }
    PERSON {
        string name PK
    }
    DATASET {
        string id PK
        string name
    }
    LEAD_STAGE {
        string name PK
    }
    SYNC_QUEUE_ITEM {
        string id PK
        string leadId FK
        string kind "New lead"
    }
```

## Form field → LEAD column

| Form label | Input name | Column |
| --- | --- | --- |
| Property owner | `name` | `lead.name` |
| Property address | `address` | `lead.address` |
| City | `city` | `lead.city` |
| State / region | `region` | `lead.region` |
| Country | `country` | `lead.country` |
| Unit / address line 2 | `unit` | `lead.unit` |
| ZIP code | `zip` | `lead.zip` |
| Latitude / Longitude | `latitude`, `longitude` | `lead.latitude`, `lead.longitude` (validated by `coordinates()`; invalid values are not pinned) |
| Phone | `phone` | `lead.phone` |
| Email | `email` | `lead.email` |
| Responsible person | `assignee` | `lead.assignee` |
| Callback time | `callback` | `lead.callback` |
| Estimated property value | `value` | `lead.value` |
| What do we know so far? | `context` | `lead.motivation` |

Defaults set by the code, not by the form: `stage` New, `source` "Added manually", `datasetId` `d04`, `verdict` Unverified, `priority` Normal, `shared` false, empty `calls` and `notes`, `beds` 3, `baths` 2, `area` 1600. The assignee defaults to the signed-in person.

Action: `NEW_LEAD` appends the lead; when offline it also adds a `SYNC_QUEUE_ITEM`. No note, task or activity row is created. The page then opens the new lead record.
