# Chats

**State:** plan only, nothing built. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

Personal chats, agency chats and lead threads: how they are kept apart, who can message whom, blocking and reports, takeover of a lead thread, and notifications.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D6 | Chats between people need no agency ("personal chats"). Anything with a lead or a real phone number is locked to one agency, and every participant must be in that agency. | - |
| D8 | The extra protections for personal chats (message requests, block, report, limits) are built with them, not later. | - |
| D9 | A lead thread is reachable only while the person is working inside that agency's workspace. Being a member is required but not enough: from another agency's workspace or from Personal it is not shown, fetched or stored. The thread belongs to the agency. | - |
| D10 | Personal chats are a separate space in the Inbox and live in **their own database**, served by the same messaging service. | - |
| D11 | A stranger can be reached only by their full `Name#id`, and their first message is a request the other person accepts. | - |
| D12 | Platform staff can read reported messages only (with a few before and after for context). Report copies are kept 90 days. | - |
| D16 | A lead thread follows the lead: whoever may see the lead may see its thread (the assigned agent, that team's manager, the agency owner). | - |
| D17 | In a lead thread one agent sends. The manager and owner read, leave internal notes, and can **take over** to send in the agent's place. | - |
| D18 | After a takeover the manager or owner hands control back. The agent can ask for it back; they cannot take it. The lead sees no change. | - |
| D19 | A lead moved to another agent or team takes its thread and full history with it. The previous agent loses the thread. | - |
| D20 | When an agent leaves or is removed, their lead threads go to the team's manager (to the owner if the team has none). | - |
| D21 | A lead's unanswered text waits with the agent; after a time each agency sets (15 minutes by default) the team's manager is told and can take over. | - |
| D23 | An agency owner cannot read the agency's internal chats they are not in. Lead threads are different and always visible to the owner. | - |
| D24 | Agency chats cannot be blocked. A member can mute, archive or hide them. Blocking is for personal chats. | - |
| D31 | A blocked person is told ("You cannot message this person"). | - |
| D32 | In a shared personal group, a blocker and the blocked both stay; each one's messages are hidden from the other and can be shown on demand. Nobody else is told. | - |
| D33 | A block covers personal chats only. Work chats between the same two people in a shared agency continue; the blocker is told this when blocking. | - |
| D34 | A block closes every route: direct message, request, search, and being added to a group together. A new account made to get around a block is abuse. | - |
| D35 | Unblocking brings the old conversation back. Messages attempted during the block were never delivered and do not appear. | - |
| D36 | Personal chats allow what agency chats allow (text, replies, reactions, polls, GIFs, and photos and files when built), minus the lead card and lead location. | - |
| D37 | When an account is deleted its messages stay for the others, shown as "Deleted user". Agency chats and lead threads stay with the agency. | - |
| D39 | Activity in an agency the person is not working in shows as a badge on the switcher and as a notification in its own category, with no details. | - |
| D40 | Notifications have categories: this agency's work, other agencies, personal chats, account and security. The notification screen has Read and Unread tabs. Each person can switch a category off, except account and security. | - |
| D42 | An agency cannot limit or hide its members' personal chats. | - |
| D48 | When a team has several managers, all of them and their deputies are told about an agent's handed-on threads and unanswered texts. The first to act holds it and the others see who. | - |
| D50 | After reviewing a report, staff can warn the person, limit their personal chats for a period, suspend the account, or dismiss. A suspension applies across Caller Whale; each affected agency owner is told the member is suspended, not why. | - |
| D51 | Clients and partners see only the partner threads shared with them inside an agency, and have a Personal space like anyone else. | - |
| D52 | Every team gets its own team chat automatically. Managers, deputies and agents join and leave it as they join and leave the team. | - |
| D53 | Inside an agency, any member can start a chat with any other member. | - |
| D55 | A message can be edited for 15 minutes (marked "edited") and deleted at any time (leaving "Message deleted"). A text already sent to a lead cannot be edited or unsent. | - |
| D60 | Personal chats start with: 20 new people a day, 5 pending requests at a time, 30 messages a minute, groups up to 50 people. | - |
| D61 | Reports are reviewed by the platform owner and cofounder only, with a second step, and every look is recorded. | - |
| D72 | Agency chats always show read status and online status. In personal chats each person chooses; hiding yours hides others' from you. | 8, 16 |
| D73 | A personal group has an owner (its creator) who can name admins. Owner and admins add and remove people; anyone can leave. Someone added by a person they do not know gets a request first. | 7 |
| D74 | Each agency has an announcements channel with every member in it. Only the owner and managers post; everyone can react. Posts marked important cannot be muted. | 16 |
| D75 | An agency's internal chat messages are kept while the agency exists. Lead threads follow the lead's record and the legal rules for texts. | 9 (lawyer) |
| D76 | Takeover follows rank: owner over manager, manager over deputy, deputy over agent. Control is handed back down the same way. | 10 |
| D77 | If the holder of a taken-over thread does not answer a new text within the agency's wait time, control returns to the agent and both are told. | 10 |
| D79 | The owner sets the agency's working hours and time zone. A team can have its own hours. They control the unanswered-text wait. | 10 |
| D84 | Outside the app, notifications can reach a person by browser notification, by email for important things (invitations, security, an unanswered lead text), and by a daily email digest. Each can be switched off; a person can choose nothing outside the app. A browser notification shows no lead details. | 14 |
| D85 | Each person can set quiet hours. Account and security alerts still come through. Work alerts also pause outside the agency's working hours. | 14 |
| D86 | Agency chats have `@person`, `@team`, `@everyone` and `@managers`. In large groups and announcements only the owner and managers can use `@everyone`. | 16 |
| D87 | People can search message text, only in conversations they belong to and only in the space they are in (one agency, or Personal). Never across agencies. | 16 |
| D88 | Personal chats have automatic protection: someone whose requests are mostly declined or reported is slowed down, then limited until staff review. It works from counts, not from reading messages. | 7 |
| D89 | A person limited or suspended after a report can appeal once. A different reviewer decides (for now, whichever of the owner and cofounder did not make the first decision). | 7 |
| D90 | A link from someone not yet accepted shows a warning before it opens. When files are built, only common safe types are allowed and they are scanned. | 7 |
| D96 | Internal notes in a lead thread are read and written by everyone who can see the thread, and move with it on reassignment. | 10 |

## Notes

- D84: all four delivery options were ticked, including "nothing outside the app". Recorded as: the three channels exist and the person can switch all of them off.
- D10 changed the earlier design. Personal chats do not share tables with agency chats; they have their own database.

## Chat separation

**Three kinds of chat**

| Kind | Belongs to | Who can be in it | Leads or real numbers |
| --- | --- | --- | --- |
| Personal chat (direct or group) | The people in it | Any Caller Whale users | Never |
| Agency chat (direct or group) | The agency | Members of that agency | No |
| Lead thread | The agency | Members of that agency with access to the lead | Yes |

A lead thread belongs to the agency, not the person (D9). It can be opened only from inside that agency's workspace: the request must name that agency and pass its access check, which is how every agency request already works. From another agency's workspace or from Personal it does not appear in lists, search, notifications' text or the cache; only that agency's unread badge in the switcher shows something is waiting. When someone leaves or is removed, the history stays with the agency and they can no longer read or continue it.

The same holds for agency chats: they are opened from inside their agency's workspace only.

**Enforced in the database, not only on screen**
- **Two databases (D10).** Personal chats live in their own database ("Caller Whale Personal Chat PostgreSQL", private, like the messaging database). The agency database keeps its required agency id on every row, unchanged. The messaging service connects to both: one codebase for replies, reactions and polls, and no table ever holds both kinds.
- The personal database has no lead column, no external number and no text-message transport at all, so a lead thread cannot exist there. Its row security shows a conversation only to its members.
- A personal request can reach only the personal database, and an agency request only the agency database. The route decides which, never a value sent by the app.
- A conversation never changes kind. There is no "move to an agency" and no "make personal".
- The contact card and lead location attachments are refused in personal chats by the server.
- **Roster sync.** Removing someone from an agency removes them from that agency's conversations at that moment. (Problem 21.)
- **Limit to be honest about:** nobody can stop a person typing a lead's number by hand. The terms forbid it, and any member can report it.

**Who can message whom**
- People who share an agency can start a personal chat directly.
- A stranger found by full `Name#id` sends a **message request**. Nothing more is delivered until the person accepts. Group invitations from people they do not know work the same way.
- **Block** and **report** are in every conversation. A report stores a copy of the reported messages, with a few before and after, for platform staff, who can read nothing else (D12). Copies are deleted after 90 days.
- **Limits:** new personal chats per day, a per-person send rate (the Redis-backed limit already on the "not built" list in `messaging-rollout-status.md`), and a smaller size for personal groups.

**Blocking (D24, D31 to D35)**
- Blocking exists in personal chats only. Agency chats can be muted, archived or hidden, never blocked; a problem with a teammate goes to a manager or the owner.
- The blocked person is told: "You cannot message this person."
- A block closes every route between the two: direct messages, requests, search, and being added to a new group together.
- In a personal group both are already in, both stay. Each one's messages are hidden from the other ("Hidden message, show"), and nobody else is told.
- If the two share an agency, their work chats continue. The person blocking is told this at the moment they block.
- Unblocking brings the old conversation back. Messages tried during the block were never delivered.
- A new account made to get around a block can be reported as abuse.

**After a report (D50)**
- Staff can warn, limit personal chats for a period, suspend the account, or dismiss. The reporter is told it was reviewed.
- A suspension applies across Caller Whale. Each agency the person is in is told they are suspended, not why.

**Other rules**
- Personal chats carry what agency chats carry, minus the lead card and lead location (D36).
- An agency owner cannot read agency chats they are not in (D23), and no agency can limit or hide personal chats (D42).
- A deleted account's messages stay, shown as "Deleted user" (D37). *The lawyer may change this.*
- Clients and partners see only partner threads shared with them inside an agency, and have their own Personal space (D51).

**Requests and live updates**
- Personal routes need a signed-in person with a confirmed email, and no agency.
- The live channel stays one per person. A prompt with no agency is Personal. A prompt for the current agency fetches as today. A prompt for another agency only raises that agency's badge in the switcher; nothing is fetched or stored.

**Screens (web)**
- The Inbox gets a switch between the agency and Personal. Personal does not change when the agency is switched.
- New personal chat: search by name or `Name#id`. A "Requests" row above the list. Block and report in the conversation menu.

## Lead threads

Lead threads are not built yet (the schema has the columns, no request creates them; they arrive with the SMS stage in `messaging-sms-voice.md`). These rules are for when they are.

- **Access follows the lead (D16).** Opening a thread asks "may this person see this lead?" The answer comes from the same rule that already gives tasks and leads only down the team tree, and is remembered for a few seconds. *How the core service decides lead access by team has not been read yet.*
- **One sender (D17).** The assigned agent sends. The team's manager and the owner can read, and can leave internal notes the lead never receives (the database already refuses to send a note by text).
- **Takeover (D17, D18).** A manager or the owner presses "Take over". From then on they send and the agent can only read. Everyone in the thread sees who holds it. The agent can press "Ask for it back", which notifies the holder; only the holder gives it back. The lead sees the same number and the same thread. Inside the app every message shows who really sent it, and each takeover and hand-back is a line in the thread and in the agency's activity record.
- **Reassignment (D19).** Moving the lead moves the thread with all its history. The previous agent stops seeing it at once.
- **Agent leaves (D20, D25, D48).** Their threads go to the team's managers and deputies, or to the owner when the team has none. All are told; the first to act holds the thread and the others see who. The owner can then hand the work on as they choose. This runs in the same step that removes the person from the agency's conversations (roster sync).
- **Unanswered texts (D21, D48).** A reply from a lead waits with the agent as unread. After the agency's wait time (set in the agency's settings, 15 minutes by default, counted in working hours) the team's managers and deputies are notified, and the first to act takes over.
- **Lead ownership (D49).** A lead belongs to one team and one agent of that team. An agent in several teams sees each team's leads under that team; a team's managers never see the agent's leads from another team.

## Notifications

- **Categories:** this agency's work; other agencies; personal chats; account and security.
- **Other agencies** carries no details: "New activity in Agency B", plus the badge on the switcher.
- **The notification screen** has Read and Unread tabs, and filters by category.
- **Settings:** each category can be switched off, except account and security (invitations, sign-ins, role changes, suspension, removal).
