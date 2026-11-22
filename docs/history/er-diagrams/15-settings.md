# Page 15 – Settings (`#/settings/:section`)

Source: `src/Management.jsx` (`Settings`). Roles with the page: owner, manager, admin, solo. Sections depend on capabilities: **Workspace** (everyone with the page), **Follow-up rules** (`rules`), and with `admin`: **People & permissions**, **Communication**, **Services & storage**. The Caller Whale logo menu also links here.

## ER diagram

```mermaid
erDiagram
    WORKSPACE_SETTINGS ||--|| WORKSPACE : "describes"
    WORKSPACE ||--|{ PERSON : "members"
    PERSON }o--|| ROLE : "plays"
    ROLE ||--o{ PERMISSION_OVERRIDE : "tweaked per capability"
    ROLE }o--o{ CAPABILITY : "preset grants"
    PERMISSION_OVERRIDE }o--|| CAPABILITY : "for"
    WORKSPACE ||--o{ RULE : "follow-up rules"
    WORKSPACE ||--|{ INTEGRATION : "Email SMS Voice"
    WORKSPACE ||--|{ PLANNED_SERVICE : "architecture preview"

    WORKSPACE_SETTINGS {
        string workspace "Workspace name"
        string timezone "America/New_York, Chicago, Los_Angeles, Africa/Cairo"
        int dailyGoal "Daily outreach goal, 1 to 500"
    }
    WORKSPACE {
        string name PK
    }
    PERSON {
        string name PK
        string badge "Caller, Closer, Research, Manager"
    }
    ROLE {
        string id PK
        string name
        string title
        string scope
        string capabilities
    }
    CAPABILITY {
        string id PK "edit assign handoff accept call message export finance import review rules admin"
        string label
    }
    PERMISSION_OVERRIDE {
        string role FK
        string capability FK
        bool allowed
    }
    RULE {
        string id PK
        string name
        string when
        string action
        bool enabled
    }
    INTEGRATION {
        string name PK "Email SMS Voice"
        string provider "SMTP IMAP Google Microsoft Twilio custom adapter"
        string displayName "typed in the modal, not saved"
        bool connected
    }
    PLANNED_SERVICE {
        string language PK "Rust Python Go C++ C JavaScript"
        string purpose
        string folder
    }
```

`CAPABILITY`, `PLANNED_SERVICE` and the member list are fixed lists in the UI, not editable rows.

## Sections → data

| Section | Elements | Action |
| --- | --- | --- |
| Workspace | form: Workspace name, Display timezone, Daily outreach goal; member list of four people with role badges | `SETTINGS` (needs `admin` or `rules`) |
| Follow-up rules | one row per `RULE` (name, When, Then), switch Enabled/Paused, Preview rule (message only, nothing runs) | `RULE` toggles `enabled` (needs `rules`) |
| People & permissions | role preset select (all 8 roles), scope card, 12 capability checkboxes | `PERMISSION` writes a `PERMISSION_OVERRIDE`; the checkbox shows the override, else the preset |
| Communication | three cards (Email, SMS, Voice) with provider text and status badge; modal with display name and provider | `INTEGRATION` sets `connected`; no credentials are sent or stored |
| Services & storage | six planned language services, PostgreSQL card, Redis card | read-only |

The 12 capability labels: Edit visible leads, Assign responsibility, Request handoffs, Accept handoffs, Work calling queue, Use conversations, Export visible records, View deal financials, Import source data, Review Skip Tracing, Configure rules, Administer workspace.

Settings are local-only actions: `SETTINGS`, `INTEGRATION`, `PERMISSION` and `RULE` never reach the server in connected mode.
