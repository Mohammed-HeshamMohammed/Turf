# Page 12 – Skip Tracing (`#/skip`, `?list=:datasetId`)

Source: `src/DataPages.jsx` (`SkipTracing`), `src/SourceFieldMapping.jsx`, `src/skiptrace-fields.js`, `src/PropertyMap.jsx`. Roles with the page: owner, researcher, solo. Needs `review` or `import`. Five steps: **Source fields → Call outcomes (only when a populated phone field exists) → Warning signs → Results → Save a copy**. The check is a timed UI simulation; nothing runs in the background.

## ER diagram

```mermaid
erDiagram
    DATASET ||--o{ LEAD : "rows in the source"
    DATASET ||--|{ SOURCE_COLUMN : "original CSV header"
    DATASET ||--o| FIELD_MAPPING : "saved per source (SOURCE_MAPPING)"
    FIELD_MAPPING }o--|| SOURCE_FIELD : "one entry per field"
    FIELD_MAPPING }o--o| SOURCE_COLUMN : "chosen column or none"
    SOURCE_FIELD ||--o{ EVIDENCE_RESULT : "counted rows"
    EVIDENCE_RESULT }o--|| DATASET : "computed per source"
    LEAD ||--o{ SOURCE_VALUE : "original cells"
    LEAD ||--|| CHECK_RESULT : "sample verdict"
    SKIP_RUN ||--|| DATASET : "checks"
    SKIP_RUN ||--o{ CHECK_RESULT : "produces"
    SKIP_RUN ||--|| WARNING_SIGNALS : "uses"
    DATASET ||--o{ ACTIVITY : "Saved a demo check"

    DATASET {
        string id PK
        string name
        string status "Not checked, Needs review, Checked"
        string team
        string columns
        object fieldMappings
    }
    SOURCE_COLUMN {
        string name PK
    }
    SOURCE_VALUE {
        string leadId FK
        string column FK
        string value "never changed"
    }
    SOURCE_FIELD {
        string id PK
        string label
        string group
        string aliases "regular expression for auto-detect"
    }
    FIELD_MAPPING {
        string datasetId FK
        string fieldId FK
        string column FK
    }
    EVIDENCE_RESULT {
        string fieldId FK "phone address email name"
        string column "or first + last name, street number + name"
        int count "rows with a supplied value"
        bool isPrimary "Start here"
    }
    LEAD {
        string id PK
        string datasetId FK
        string verdict "Ready to call, Unverified, Possible duplicate, Do not call"
        string phone
        string address
        float latitude
        float longitude
    }
    CHECK_RESULT {
        string leadId FK
        string verdict "Unverified when no phone field exists"
        string startingEvidence
    }
    SKIP_RUN {
        string mode "Local or Cloud"
        int step "0 to 4"
        int progress "-1 idle, 0 to 4 running"
        bool finished
        bool cancelled
        bool hideEmpty
    }
    WARNING_SIGNALS {
        bool duplicates
        bool outcomes "disabled without a phone field"
        bool dnc "disabled without a phone field"
        bool age
    }
    ACTIVITY {
        string id PK
        string kind "Research"
        string text
    }
```

`SKIP_RUN`, `WARNING_SIGNALS`, `EVIDENCE_RESULT` and `CHECK_RESULT` are page state or computed values; they are not saved. Only `DATASET.fieldMappings` (via `SOURCE_MAPPING`), `DATASET.status` (via `CHECK`) and the `ACTIVITY` row are saved.

## Evidence order

The first field with at least one supplied value becomes the starting evidence: **Phone → Address → Email → Owner name**. Coordinates count as a fallback ("Latitude + longitude"). A value is not "supplied" if it is empty, n/a, none, null, unknown, "Address not supplied", "Imported owner N" or "-". If there is no populated phone field, the Call outcomes step is hidden, the outcomes and do-not-call signals are disabled, and every verdict except existing Do not call / Possible duplicate shows as Unverified.

## Steps → data

| Step | Fields | Action |
| --- | --- | --- |
| Source select | `DATASET` list the person can see | resets overrides and the run |
| 1 Source fields | `SOURCE_FIELD` ↔ `SOURCE_COLUMN` mapping grid grouped as Contact & identity, Property & location, Mailing & evidence; original-value preview table with "hide empty columns" | `SOURCE_MAPPING` saves per source |
| 2 Call outcomes | imported call-status field select; preview of Reached, No answer / voicemail, Wrong number, Do not call | local override (`outcome`) |
| 3 Warning signs | four signal switches | – |
| Run demo check | needs a primary evidence field; Cloud mode needs a connection | starts the 5-stage simulated job: Reading source rows, Reviewing evidence, Comparing candidate pairs, Building lead groups, Preparing the review |
| 4 Results | counts of rows, Ready to call, possible repeats; one row per lead with verdict | review opens the lead |
| 5 Save a copy | – | `CHECK` sets `DATASET.status` to Checked and adds an `ACTIVITY`; or export CSV (`columns` + Sample verdict + Starting evidence) |
| Source location map | `lead.latitude/longitude`, mapped coordinate fields | supplied coordinates versus approximate areas |
| Check context / Evidence order cards | source name, row count, starting evidence, execution mode | – |
