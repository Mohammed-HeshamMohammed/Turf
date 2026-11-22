# Page 17 – My account (`#/personal/profile`, `#/personal/preferences`)

Source: `src/Personal.jsx`, `src/EmailChange.jsx`, `src/avatars.js`. Opened from the avatar menu (My profile, Notification preferences). The avatar menu also links to My tasks (`work/tasks?mine=1`) and My calendar when the role has them. Every role can open it.

Personal settings are saved per **display name of the sample account** (`state.personal[person]`) and stay on this device. In connected mode `PERSONAL` is a local-only action.

## ER diagram

```mermaid
erDiagram
    ROLE ||--|| PERSON : "is played by"
    PERSON ||--|| PERSONAL_PROFILE : "has"
    PERSONAL_PROFILE }o--o| AVATAR_PRESET : "picks one"
    PERSONAL_PROFILE ||--o{ EMAIL_CHANGE : "requests"
    PERSONAL_PROFILE ||--|| NOTIFICATION_PREFERENCES : "has"
    NOTIFICATION_PREFERENCES ||--o{ TASK : "taskReminders show open tasks"
    NOTIFICATION_PREFERENCES ||--o{ THREAD : "replyReminders show unread threads"
    PERSON ||--o{ LEAD : "ownership stays on the canonical name"

    PERSON {
        string name PK "canonical name used by lead assignee"
    }
    ROLE {
        string id PK
        string name
        string scope
    }
    PERSONAL_PROFILE {
        string person FK "key in state.personal"
        string name "Display name, max 80"
        string email
        string avatar "empty, preset, or uploaded data URL"
    }
    NOTIFICATION_PREFERENCES {
        bool taskReminders "default true"
        bool replyReminders "default true"
    }
    AVATAR_PRESET {
        string id PK "AVATAR_PRESETS in avatars.js"
    }
    EMAIL_CHANGE {
        string newEmail
        string code "confirmation step in EmailChange.jsx"
    }
    TASK {
        string id PK
        string assignee
        bool done
    }
    THREAD {
        string id PK
        bool unread
    }
    LEAD {
        string id PK
        string assignee FK
    }
```

## Profile tab

| Element | Data | Action |
| --- | --- | --- |
| Avatar grid | default initial avatar + presets + uploaded photo | `PERSONAL {avatar}`. Upload is resized to a square data URL in the browser (`squareAvatar`) |
| Display name | `profile.name` | `PERSONAL {name}`. Does not change `assignee` on leads |
| Contact email | `profile.email` (default `first.last@example.com`) | change flow in `EmailChange` (confirmation step) |
| Your workspace identity card | name, email, role name, `settings.workspace`, `role.scope` | read-only |

## Preferences tab

| Switch | Field | Effect |
| --- | --- | --- |
| Task reminders | `taskReminders` | bell panel lists open tasks |
| Unread conversations | `replyReminders` | bell panel lists unread threads (only if the role has Inbox) |

Preferences control in-app notices only. No email or SMS is sent.
