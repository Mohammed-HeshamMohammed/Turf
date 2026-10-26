# Events

Services announce what happened on the event bus (Redis Streams to start). An event is a past-tense fact with a stable name, a version and the ids of the things it is about. It never carries a password, a token or a whole record.

| Event | Published by | Read by | Meaning |
| --- | --- | --- | --- |
| `user.signed_up` | auth | notifications, billing | A new account exists. Carries the user id and organization id |
| `user.signed_in` | auth | (audit) | A person signed in. Carries the user id and the device |
| `subscription.changed` | billing | every feature service | A plan's entitlements changed. Carries the subscription id and the new entitlements version |
| `payment.failed` | billing | notifications | A payment did not go through. Carries the subscription id |
| `notification.requested` | any service | notifications | Someone must be told something. Carries the user id, a template name and its data |
| `import.completed` | importing-lists | crm, notifications | A list finished importing. Carries the list id and the counts |
| `skiptrace.completed` | skip-tracing | crm, notifications | A check finished. Carries the list id and the counts |
| `call.completed` | dialer-sms | crm, skip-tracing | A call ended. Carries the lead id, outcome and duration |
| `message.received` | dialer-sms, ai-campaigns | crm | A text or email reply arrived |
| `lead.changed` | crm | exports, ai-campaigns, backup-restore | A lead was created, changed or removed |
| `export.ready` | exports | notifications | A file is ready to download |
| `workspace.restored` | backup-restore | crm, notifications | A workspace was restored to an earlier moment |

Rules: events are append-only; consumers must be safe to run twice (an event can be delivered again); and a breaking change makes a new event name or version, never a silent change.
