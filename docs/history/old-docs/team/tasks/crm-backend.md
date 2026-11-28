# CRM backend (Go)

`crm-core`, `crm-merge`, `crm-outbox`, `messaging`, `auth`, `authz`, `notifications`. Step numbers are from the
[people, teams, chats and clients plan](../../plans/people-teams-chats-clients/README.md#build-order).

| ID | Task | Needs | Source | Taken by | Status |
| --- | --- | --- | --- | --- | --- |
| CRM-01 | Personal chats: the second database, personal routes in `messaging`, tests that try to cross between the two databases in every direction; roster sync for agency conversations | — | Step 6 | | open |
| CRM-02 | Message requests, block, report (90-day copies) and limits | CRM-01 | Step 7 | | open |
| CRM-03 | Notification categories, Read and Unread, per-category settings (server side) | — | Step 14 | | open |
| CRM-04 | The daily email during a plan's grace period | CRM-03 | Step 18 | | open |
| CRM-05 | Deleting a closed agency's data after 30 days | LAW-12 | Step 18, D82, D206 | | open |
| CRM-06 | Clients: the main contact inviting colleagues, the client conversation, partners, two agencies of one client | — | Step 23, D134, D137, D245, D246 | | open |
| CRM-07 | Budgets: the lead's client in each charge; skip tracing and AI use counted | CRM-06 | Step 22, D218, D221 | | open |
| CRM-08 | Booking through the calendar counts once for commission | — | Steps 27, 28 | | open |
| CRM-09 | A removed person's calendar events move when their work is handed on | — | Step 28 | | open |
| CRM-10 | Email: the agency's own wait time, HTML email, bounces and complaints feeding the rates | INF-06 | Steps 29, 39, D269 | | open |
| CRM-11 | Unusual-access alerts sent to the owner and admins as a notification | CRM-03 | Step 30 | | open |
| CRM-12 | Overview cards from billing, auth and the dialer put together on the dashboard | — | Step 32 | | open |
| CRM-13 | Notice to the team's leads when a website-form lead arrives | CRM-03 | Step 36 | | open |
| CRM-14 | Notice to the receiving owner when a lead is sent from another agency | CRM-03 | Step 37 | | open |
| CRM-15 | The apps send `idle_seconds` and `on_call` with each refresh; in-app notice beside the new-device email | CRM-03 | Step 35 | | open |
| CRM-16 | Turn on the `teams_v2` switch for a first agency and watch it | WEB-03 | Step 11, D104 | | open |
| CRM-17 | Using the shared learning figures in the AI's suggestions | LAW-17 | Step 45 | | open |
