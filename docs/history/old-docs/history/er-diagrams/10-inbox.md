# Page 10 – Inbox (`#/work/inbox`, `?lead=:id`)

Source: `src/Work.jsx` (`Inbox`). Conversations per lead. Needs `message` or `publicComment` to write. Channels: All, SMS, Email, Team, Partner. A client only sees threads with `shared: true`, and can only start Partner threads. No real message is sent.

## ER diagram

```mermaid
erDiagram
    LEAD ||--o{ THREAD : "has conversations"
    THREAD ||--o{ MESSAGE : "contains"
    PERSON ||--o{ MESSAGE : "from (outgoing)"
    THREAD }o--|| CHANNEL : "sent over"
    THREAD ||--o{ SYNC_QUEUE_ITEM : "Communication draft when offline"
    INTEGRATION ||--o| CHANNEL : "provider status in Settings"

    THREAD {
        string id PK
        string leadId FK "Related lead"
        string channel FK "SMS Email Team Partner"
        bool shared "Partner threads are shared"
        string preview
        bool unread
    }
    MESSAGE {
        string threadId FK
        string from "lead name or team member"
        string text
        string at
        bool incoming
        bool draft "saved offline, not sent"
    }
    CHANNEL {
        string name PK "SMS Email Team Partner"
    }
    LEAD {
        string id PK
        string name
        string address
    }
    PERSON {
        string name PK
    }
    SYNC_QUEUE_ITEM {
        string id PK
        string leadId FK
        string kind "Communication draft"
        string status
    }
    INTEGRATION {
        string name PK "Email SMS Voice"
        bool connected
    }
```

`MESSAGE` rows are stored inside `thread.messages`. `CHANNEL` is a fixed list in the UI (Partner and Team have no matching `INTEGRATION`).

## UI → data

| Element | Fields | Action |
| --- | --- | --- |
| Channel tabs | `thread.channel` | filter only |
| Thread list row | `lead.name`, `thread.preview`, `thread.channel`, `thread.unread` | click selects and runs `MARK_READ` |
| Conversation | `thread.messages[]`: `from`, `text`, `at`, `incoming`, `draft` | – |
| Composer (text + attach file name) | text, attachment file name (name only, nothing stored) | `MESSAGE` → appends message, sets `preview`, clears `unread`. Offline: message is a draft ("Offline draft") and a `SYNC_QUEUE_ITEM` is queued |
| New conversation modal | Related lead, Channel | `NEW_THREAD`: new empty `THREAD` (client forced to shared Partner) |
| Unread count | threads with `unread` | shown in sidebar, top bar and bell |
