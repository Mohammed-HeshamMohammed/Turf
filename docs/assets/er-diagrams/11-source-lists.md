# Page 11 – Source lists (`#/lists`, `#/lists/:datasetId`)

Source: `src/DataPages.jsx` (`Lists`), `src/PropertyMap.jsx`. Roles with the page: owner, manager, researcher, solo. Importing needs the `import` capability. Original CSV values are kept in `lead.sourceValues` and never edited.

## ER diagram

```mermaid
erDiagram
    DATASET ||--o{ LEAD : "supplied (datasetId)"
    DATASET ||--o| FIELD_MAPPING : "saved per source"
    DATASET ||--|{ SOURCE_COLUMN : "original CSV header"
    LEAD ||--o{ SOURCE_VALUE : "original row, one cell per column"
    SOURCE_COLUMN ||--o{ SOURCE_VALUE : "holds"
    FIELD_MAPPING }o--|| SOURCE_FIELD : "maps one field"
    FIELD_MAPPING }o--o| SOURCE_COLUMN : "to this column"
    LEAD }o--|| LEAD_STAGE : "CRM stage column"
    ROLE ||--o{ DATASET : "team scopes visibility"

    DATASET {
        string id PK
        string name "file name without .csv"
        string description
        string status "Checked Needs review Not checked"
        string team
        string date
        string columns "header row of the CSV"
        object fieldMappings "optional"
    }
    SOURCE_COLUMN {
        string name PK "e.g. Owner Address City Phone Email"
    }
    SOURCE_VALUE {
        string leadId FK
        string column FK
        string value "kept exactly as imported"
    }
    SOURCE_FIELD {
        string id PK "name phone email address firstName lastName unit streetNumber streetName city region zip country county latitude longitude parcel mailing fields outcome value"
        string label
        string group "Contact and identity, Property and location, Mailing and evidence"
    }
    FIELD_MAPPING {
        string datasetId FK
        string fieldId FK
        string column FK
    }
    LEAD {
        string id PK
        string datasetId FK
        string name "from mapped name or Imported owner N"
        string address "from mapped address or Address not supplied"
        string phone
        string email
        string stage "New on import"
        string assignee "Unassigned on import"
        string verdict "Unverified on import"
        string source "CSV import"
        int value
        object sourceValues "original row"
    }
    LEAD_STAGE {
        string name PK
    }
    ROLE {
        string id PK
        string team
        string capabilities
    }
```

## UI → data

| Element | Fields | Action |
| --- | --- | --- |
| Lists grid cards | `dataset.name`, `description`, `status`, `team`, `date`, record count | opens `lists/:id` |
| Import CSV button / file picker | CSV text via PapaParse (header row required) | `IMPORT`: one `DATASET` + up to 200 new `LEAD` rows |
| Try a sample import | 2 rows, columns Owner, Address, City, Phone, Email | `IMPORT` |
| Import errors | non-`.csv`, larger than 2 MB, parse error, no data rows | message only |
| List page header | `dataset.name`, visible record count | – |
| Export view | `dataset.columns` values via `sourceValue()` + CRM stage | CSV download, needs `export` |
| Call this list | – | `work/calls?list=:id`, needs `call` |
| Open in Skip Tracing | – | `skip?list=:id`, needs `review` or `import` |
| Context strip | `dataset.status`, `dataset.team`, column names | – |
| Source list map | `lead.latitude/longitude` or address area | see map rules in AGENTS.md |
| Table | owner (`LeadLink`), `address`, `city`, `region`, `phone` (or "No phone supplied"), `verdict`, `stage` | row opens the lead |

Visibility: a dataset is listed if the person can see at least one of its leads, or if they have `import` and the dataset belongs to their team.
