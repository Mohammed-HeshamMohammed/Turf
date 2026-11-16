# People, invitations and chat separation

**Written:** 2026-11-16. **State:** plan only, nothing built. Scope is the **web version** (the Dashboard on `callerwhale.com` and the CRM on `app.callerwhale.com`); the desktop (Tauri) app and other local apps are out of scope for now.

This plan comes from a review of the invitation flow (`services/auth/invitations.go`, `services/authz/tree.go`, `landing/site/src/AccessManagement.tsx`, `desktop/frontend/react/src/RemoteGate.jsx`) and of messaging (`services/messaging`). Everything under "What exists" was read in the code, not run.

## Decisions

Decided by the owner:

| # | Decision |
| --- | --- |
| D1 | One person can belong to several agencies. This is a supported case. |
| D2 | A person's name, email and other profile details are one profile, shared with every agency they are in. |
| D3 | A personal phone number is shown only if the person chooses to: a setting next to authentication. |
| D4 | The web cache refreshes automatically; a manual reload stays as a fallback. |
| D5 | Display names get a `#id` tag so two people never look the same in a search. Everyone normally sees the name without the tag. |
| D6 | Chats between people need no agency ("personal chats"). Anything with a lead or a real phone number is locked to one agency, and every participant must be in that agency. |
| D7 | When the person who sent an invitation is removed, the invitation is cancelled and gives no access. |
| D8 | The extra protections for personal chats (message requests, block, report, limits) are built with them, not later. |
| D9 | A lead thread is reachable only while the person is working inside that agency's workspace. Being a member is required but not enough: from another agency's workspace or from Personal it is not shown, fetched or stored. The thread belongs to the agency. |
| D10 | Personal chats are a separate space in the Inbox and live in **their own database**, served by the same messaging service. |
| D11 | A stranger can be reached only by their full `Name#id`, and their first message is a request the other person accepts. |
| D12 | Platform staff can read reported messages only (with a few before and after for context). Report copies are kept 90 days. |
| D13 | Removing an inviter cancels pending invitations only. People who already accepted keep their access. |
| D14 | The tag is generated automatically and the person can change it. |
| D15 | A team manager can invite callers and closers into the teams they run. The owner sees every invitation and can withdraw any. |
| D16 | A lead thread follows the lead: whoever may see the lead may see its thread (the assigned agent, that team's manager, the agency owner). |
| D17 | In a lead thread one agent sends. The manager and owner read, leave internal notes, and can **take over** to send in the agent's place. |
| D18 | After a takeover the manager or owner hands control back. The agent can ask for it back; they cannot take it. The lead sees no change. |
| D19 | A lead moved to another agent or team takes its thread and full history with it. The previous agent loses the thread. |
| D20 | When an agent leaves or is removed, their lead threads go to the team's manager (to the owner if the team has none). |
| D21 | A lead's unanswered text waits with the agent; after a time each agency sets (15 minutes by default) the team's manager is told and can take over. |

Second round, 2026-11-17:

| # | Decision |
| --- | --- |
| D22 | Platform staff see a member's phone only through the person's own setting. |
| D23 | An agency owner cannot read the agency's internal chats they are not in. Lead threads are different and always visible to the owner. |
| D24 | Agency chats cannot be blocked. A member can mute, archive or hide them. Blocking is for personal chats. |
| D25 | A person can leave an agency at once. Their leads, tasks and threads go to their managers (or the owner), and the owner can then decide where it goes: all of it to one person, or parts to different people. The same choice applies when someone is removed. |
| D26 | A suspended person's leads and threads are held by their managers, who can read and take over. On restore everything not reassigned returns to the person. |
| D27 | If an owner's account is closed or disabled, the agency is paused (members read, nobody works) and Caller Whale staff hand it on or close it. |
| D28 | An active owner can hand the agency to a member. Both confirm with a second step; the old owner becomes a manager or leaves. |
| D29 | Name and tag changes are limited (for example twice in 30 days). An old `Name#id` is reserved for 90 days so nobody can pose as its last holder. |
| D30 | New accounts start with: people in my agencies find me by name; anyone else needs my exact `Name#id` and sends a request. |
| D31 | A blocked person is told ("You cannot message this person"). |
| D32 | In a shared personal group, a blocker and the blocked both stay; each one's messages are hidden from the other and can be shown on demand. Nobody else is told. |
| D33 | A block covers personal chats only. Work chats between the same two people in a shared agency continue; the blocker is told this when blocking. |
| D34 | A block closes every route: direct message, request, search, and being added to a group together. A new account made to get around a block is abuse. |
| D35 | Unblocking brings the old conversation back. Messages attempted during the block were never delivered and do not appear. |
| D36 | Personal chats allow what agency chats allow (text, replies, reactions, polls, GIFs, and photos and files when built), minus the lead card and lead location. |
| D37 | When an account is deleted its messages stay for the others, shown as "Deleted user". Agency chats and lead threads stay with the agency. |
| D38 | At sign-in the person chooses "This is my device" (the encrypted copy is kept) or "Shared device" (nothing is kept after sign-out or closing the tab). |
| D39 | Activity in an agency the person is not working in shows as a badge on the switcher and as a notification in its own category, with no details. |
| D40 | Notifications have categories: this agency's work, other agencies, personal chats, account and security. The notification screen has Read and Unread tabs. Each person can switch a category off, except account and security. |
| D41 | Each agency sets how long its invitations stay valid. |
| D42 | An agency cannot limit or hide its members' personal chats. |
| D43 | A team can have no manager, one, or several equal managers. Each manager can also name deputies, who can read and take over threads but not invite or change people. |
| D44 | A caller or closer can be in several teams of one agency and switches the view to the team they want to work in. The switch is a filter, not a lock: alerts for another team's lead still arrive, and opening one switches the view. |
| D45 | One person can hold several roles in an agency, for example a manager who also closes. One invitation can carry them. |
| D46 | A seat is one person in one agency, however many teams or roles they have. The same person in two agencies is one seat in each. |
| D47 | An invitation link lets a new person sign up inside it: email filled in and locked, opening the link confirms the email, and they land in the agency. |
| D48 | When a team has several managers, all of them and their deputies are told about an agent's handed-on threads and unanswered texts. The first to act holds it and the others see who. |
| D49 | A lead belongs to one team and is assigned to one agent of that team. That team's managers see it; the agent's other teams do not. |
| D50 | After reviewing a report, staff can warn the person, limit their personal chats for a period, suspend the account, or dismiss. A suspension applies across Caller Whale; each affected agency owner is told the member is suspended, not why. |
| D51 | Clients and partners see only the partner threads shared with them inside an agency, and have a Personal space like anyone else. |

Third round, 2026-11-17:

| # | Decision |
| --- | --- |
| D52 | Every team gets its own team chat automatically. Managers, deputies and agents join and leave it as they join and leave the team. |
| D53 | Inside an agency, any member can start a chat with any other member. |
| D54 | Every member sees who is in the agency, with role and team. Contact details follow each person's own settings. |
| D55 | A message can be edited for 15 minutes (marked "edited") and deleted at any time (leaving "Message deleted"). A text already sent to a lead cannot be edited or unsent. |
| D56 | A removed person can be invited back and starts fresh: nothing assigned, old chats only where they are added again. The owner sees they were a member before. |
| D57 | A reason for a removal or suspension is optional. If one is written, the person sees it. |
| D58 | The record of people changes: the owner sees all of it, managers see their teams', each person sees changes made to themselves. |
| D59 | A solo operator who adds callers upgrades in place: the same workspace becomes an agency and keeps its leads, clients and history. |
| D60 | Personal chats start with: 20 new people a day, 5 pending requests at a time, 30 messages a minute, groups up to 50 people. |
| D61 | Reports are reviewed by the platform owner and cofounder only, with a second step, and every look is recorded. |
| D62 | A deputy can be any member of the agency. Being a deputy shows that team's leads to them. |
| D63 | A team's managers and the owner name and remove its deputies. The owner sees every change. |
| D64 | Managers of a team cannot act on each other. Only the owner can. |
| D65 | Only the owner creates, renames and deletes teams. |
| D66 | A team can be deleted only when it has no members and no leads. The owner moves them first with the hand-on screen. |
| D67 | An agent taken out of one of their teams leaves that team's leads and threads with the team; its managers reassign them. The agent keeps their other teams' work. |

Fourth round, 2026-11-17 (these are complete as written here; the build order names the step for each):

| # | Decision | Step |
| --- | --- | --- |
| D68 | The invited person can decline. The sender sees "Declined" and the seat is freed at once. | 2 |
| D69 | One person can own several agencies, each with its own plan, seats, teams and data. | 13 |
| D70 | Handing over ownership completes only after the new owner adds their own payment method. The old owner's card is removed and never charged again. | 13 |
| D71 | A manager inviting with no free seat is blocked and can send the owner a request to add one. Nothing is charged without the owner. | 3 |
| D72 | Agency chats always show read status and online status. In personal chats each person chooses; hiding yours hides others' from you. | 8, 16 |
| D73 | A personal group has an owner (its creator) who can name admins. Owner and admins add and remove people; anyone can leave. Someone added by a person they do not know gets a request first. | 7 |
| D74 | Each agency has an announcements channel with every member in it. Only the owner and managers post; everyone can react. Posts marked important cannot be muted. | 16 |
| D75 | An agency's internal chat messages are kept while the agency exists. Lead threads follow the lead's record and the legal rules for texts. | 9 (lawyer) |
| D76 | Takeover follows rank: owner over manager, manager over deputy, deputy over agent. Control is handed back down the same way. | 10 |
| D77 | If the holder of a taken-over thread does not answer a new text within the agency's wait time, control returns to the agent and both are told. | 10 |
| D78 | An agent in several teams opens on the last team used, and has an "All my teams" view where each lead is marked with its team. | 11 |
| D79 | The owner sets the agency's working hours and time zone. A team can have its own hours. They control the unanswered-text wait. | 10 |

Fifth round, 2026-11-17 (complete as written; the step is where each is built, "new" means a step added below):

| # | Decision | Step |
| --- | --- | --- |
| D80 | When payment fails or the plan ends, a grace period (7 days to start) keeps everything working and warns the owner. After it, members can read but not work and invitations stop, until the owner pays. | 18 |
| D81 | Lowering the plan below the number of members cannot complete until the owner picks who keeps a seat. The others are suspended, not removed, and their work is handed on. | 18 |
| D82 | Closing an agency: members lose access at once and are told. The owner can reopen it for 30 days and export the data. Then it is deleted, except what the law requires keeping. | 18, 9 (lawyer) |
| D83 | Caller Whale staff can open an agency's workspace only when its owner allows it, for a set time (24 hours to start). They do not see internal chats, every action is recorded, and the owner can end it early. | 19 |
| D84 | Outside the app, notifications can reach a person by browser notification, by email for important things (invitations, security, an unanswered lead text), and by a daily email digest. Each can be switched off; a person can choose nothing outside the app. A browser notification shows no lead details. | 14 |
| D85 | Each person can set quiet hours. Account and security alerts still come through. Work alerts also pause outside the agency's working hours. | 14 |
| D86 | Agency chats have `@person`, `@team`, `@everyone` and `@managers`. In large groups and announcements only the owner and managers can use `@everyone`. | 16 |
| D87 | People can search message text, only in conversations they belong to and only in the space they are in (one agency, or Personal). Never across agencies. | 16 |
| D88 | Personal chats have automatic protection: someone whose requests are mostly declined or reported is slowed down, then limited until staff review. It works from counts, not from reading messages. | 7 |
| D89 | A person limited or suspended after a report can appeal once. A different reviewer decides (for now, whichever of the owner and cofounder did not make the first decision). | 7 |
| D90 | A link from someone not yet accepted shows a warning before it opens. When files are built, only common safe types are allowed and they are scanned. | 7 |
| D91 | A "My access" page lists every agency the person belongs to with role and teams, pending invitations, signed-in devices, and a Leave button per agency. | 15 |

Note on D84: all four options were ticked, including "nothing outside the app". Recorded as: the three channels exist and the person can switch all of them off.

Sixth round, 2026-11-17 (complete as written):

| # | Decision | Step |
| --- | --- | --- |
| D92 | Every invitation shows the agency's name, when it was created, and the owner's full `Name#id`, with a "Report this invitation" button that goes to staff. New agencies need no approval. | 1 |
| D93 | Pending invitations cannot exceed the agency's free seats, and there is a daily cap. A person can block an agency so it can never invite them again, and report it. | 2 |
| D94 | The owner invites any client or partner. A manager can invite a client only to share things belonging to their own teams. | 3 |
| D95 | Managers and deputies must have an authenticator set up, like owners. They are asked for a code at sign-in, not at every action. | 11 |
| D96 | Internal notes in a lead thread are read and written by everyone who can see the thread, and move with it on reassignment. | 10 |
| D97 | An agent can be in at most 5 teams of an agency (a starting number). | 11 |
| D98 | With several roles, including an agency's custom roles, a person can do what any of their roles allows. A restriction placed on the person always wins over a role. | 11 |
| D99 | A person can download their profile, settings and personal chats. Agency data belongs to the agency and is exported by its owner. | 15, 9 (lawyer) |

D94 replaces the limit written under D15 that a manager cannot invite a client.

Suggested and turned down, recorded so it is not raised again: a lock that makes a person select an active team before a lead thread can be opened (the team switch is a filter, D44).

## What exists today

**Teams and roles** (`services/authz/tree.go`)
- The agency owner creates teams. A team needs only a name; its manager is optional and can be set or cleared later.
- A team has at most one manager. One manager can run several teams.
- A caller or closer sits in exactly one team. A manager is not also a caller or closer.
- Only the agency owner (or platform staff) invites, changes roles and removes people. A manager can only suspend, restrict and set limits for the callers and closers of their own teams.

**Invitations** (`services/auth/invitations.go`)
- One invitation carries one email, one role and, for a caller or closer, one team.
- A workspace invitation lasts 72 hours, a staff invitation one hour. There is no resend or extend.
- The invited person signs in on the website with that exact email, confirms it, and presses "Accept invitation" in the Dashboard. The CRM has no invitation screen.
- Acceptance is applied in the inviter's name, with the inviter's second step marked as passed.

**Several agencies**
- Membership is stored per agency and person. The CRM has a workspace switcher; the Dashboard lists every agency.
- The web CRM keeps one encrypted copy per person in the browser, holding one agency at a time (`remote/vault.ts`, `remote/engine.ts`). Switching replaces it, so going back loads everything again.

**Messaging** (`services/messaging`)
- Every conversation (`direct`, `group`, `lead`) has a required agency id, and row security shows a request only its own agency's rows. Every request names an agency and passes an access check for it.
- Direct and group chats are limited to that agency's roster. Lead threads are in the schema but nothing creates them yet.
- Live prompts carry the agency id and conversation id, never message text.

## Problems found

**Ordering**
1. A caller or closer cannot be invited without a team, and a team can only name a manager who has already accepted. The only working order (team, agents, lead, then set manager) is not explained anywhere.
2. A manager cannot be invited with their teams attached; it is always two steps.
3. One invitation gives exactly one role.

**Who can invite**
4. Only the owner invites. A manager cannot invite into their own teams.
5. An owner without an authenticator sees the authenticator setup in place of the Members and Invite panels, with no explanation that invitations wait behind it.

**After sending**
6. Accepting happens on the website, working happens in the CRM: two sites.
7. A person whose email is not yet verified sees no invitation and no hint that one is waiting.
8. The email must match exactly. `name+x@gmail.com` cannot be accepted by `name@gmail.com`, and the error is generic.
9. A failed email send is reported as "email sending is not set up yet".
10. No resend, no extend.
11. The email link goes to `/dashboard`, not to the invitation.

**Later failures**
12. A team deleted before acceptance blocks the invitation; it stays "pending" and can only be withdrawn.
13. Seats are checked at sending and again at acceptance; the invited person can hit "seats full" at the last step.
14. If the inviter is removed or suspended, acceptance fails with a message about the inviter's role, and the invitation stays pending until it expires.
15. An older invitation path (`#/join?token=…`, `/api/v1/invitations/join`) still exists beside the auth service's invitations. Not yet traced.

**Several agencies**
16. The "Your invitations" card shows "Workspace", not the agency's name or who invited.
17. After accepting, the CRM opens the workspace the device used last, not the new one.
18. Neither agency knows about the other. (Kept as is: this is privacy, see D1.)
19. There is no way for a person to leave an agency.
20. `RemoteGate.jsx` says a removed agency's offline copy "goes too", but the code only forgets the choice. To confirm.
21. When someone is removed from an agency, their rows in that agency's chats stay: others still see them as a member and live prompts still go to them. Their access to read is refused, but the list is wrong.

## The plan

### Part 1. Invitations

- **Explain the order.** The invite form and the Teams screen say what to do first, and the invite form can create a team on the spot.
- **One invitation, everything needed.** An invitation can carry the role, the team, and for a manager the teams they will run. Those teams get their manager when the invitation is accepted. (Problems 1, 2.)
- **Managers invite into their own teams (D15).** A manager can invite callers and closers into teams they run, counted against the agency's seats. The owner sees every invitation and can withdraw any. A manager cannot invite another manager or into a team they do not run; clients follow D94. (Problem 4.)
- **Say why the panels are hidden.** The authenticator screen says that members and invitations open after it. (Problem 5.)
- **Name the agency.** The invitation card and the email show the agency's name and who invited. (Problem 16.)
- **Accept and arrive.** The email link opens that invitation. After accepting, the person is taken into the new agency, and the CRM opens it at the next sign-in. The CRM's "not invited" screen shows pending invitations and lets the person accept there. (Problems 6, 11, 17.)
- **Unverified email.** The Dashboard says "An invitation is waiting. Confirm your email to see it." (Problem 7.)
- **Wrong address.** The error says which address the invitation was sent to, masked. (Problem 8.)
- **Delivery state.** "Not set up" and "failed" are different messages. Resend and "extend by 72 hours" are added, both limited. (Problems 9, 10.)
- **Blocked, not broken.** An invitation whose team is gone or whose seat is taken shows as "Blocked" with the reason; the owner can pick another team or free a seat. A seat is held for a pending invitation, so acceptance does not fail on seats. (Problems 12, 13.)
- **Inviter removed (D7, D13).** When an inviter is removed, suspended or loses the right to invite, their pending invitations are cancelled at that moment and marked "Cancelled: inviter removed". The invited person sees "This invitation was cancelled." A restored inviter does not revive them. Acceptance still checks the inviter as a second guard. (Problem 14.)
- **One system.** Trace the old token path and remove it if nothing uses it. (Problem 15.)
- **Leaving (D25).** A person can leave an agency themselves at once, except its owner. Their work goes to their managers (or the owner) straight away so nothing is unattended, and the owner gets a "Hand on this person's work" screen: all of it to one person, or leads, tasks and threads split between several. The same screen appears when someone is removed. (Problem 19.)
- **Validity (D41).** Each agency sets how long its invitations last, between 1 and 30 days, 7 by default. Resend and extend use that length.
- **New people (D47).** The invitation link opens sign-up with the email filled in and locked. Opening the link proves the address, so the person accepts and lands in the agency in one go. The link works once and only until the invitation ends.
- **Several roles (D45).** One invitation can carry more than one role and more than one team.

### Part 2. One person, several agencies

- **Profile (D2, D3, D22).** Name, email and avatar are one profile in the auth service; agencies read it and cannot edit it. Per agency there is only role, team, limits and suspension.
- **Phone setting.** In Settings, next to authentication: "Who can see my phone number": nobody (the default), my agency's owner and managers, or everyone in my agencies. The server leaves the number out unless the setting allows it; hiding it on screen is not enough.
- **Each agency sees only itself.** No agency is told about a person's other agencies.
- **Suspension (D26).** A suspended person keeps their place. Their leads and threads are held by their managers, who can read and take over. On restore, whatever was not reassigned returns.
- **Owner gone (D27).** If the owner's account is closed or disabled, the agency is paused: members can read, nobody can work, invitations stop. Caller Whale staff hand it to another person or close it.
- **Handing over ownership (D28).** An active owner picks a member; both confirm with a second step. The old owner becomes a manager or leaves. Until both confirm, nothing changes.
- **Shared devices (D38).** At sign-in: "This is my device" keeps the encrypted copy; "Shared device" keeps nothing after sign-out or closing the tab.
- **Seats (D46).** A seat is one person in one agency.

### Part 3. Display name tag (D5, D14)

- A person's full name is `Alex Morgan#K7P2`. Everywhere in the app shows "Alex Morgan". The tag appears only to tell two people apart in a list, and in the person's own settings.
- The name and tag together are unique. Look-alike letters count as the same letter, and `#` is not allowed in a name.
- Existing people get a tag automatically; no name changes. The existing `username` (the address of a profile page, `0019_username.sql`) stays as it is.
- **Search.** Part of a name finds only people in your own agencies. A full `Name#id` finds exactly one person anywhere, with rate limits, so nobody can list every user.
- **Settings**, next to the phone setting: "Who can find me" and "Who can message me". A new account starts with: my agencies by name, anyone else by exact `Name#id` and a request (D30).
- **Changes (D29).** The name and the tag can each be changed a limited number of times (twice in 30 days to start). The previous `Name#id` cannot be taken by anyone else for 90 days.

### Part 4. Web cache (D4)

- **One slot per person per agency.** Each slot keeps what has loaded and where loading stopped, so loading resumes. Switching back does not start again.
- **Only one agency in memory.** A switch drops the previous agency's records, selection, search and filters. Drafts are kept per agency.
- **Automatic refresh, in layers:**
  1. Always: live updates and a quiet incremental refresh while the tab is visible.
  2. On events: switching back to an agency, the network returning, the tab returning after a while, a role or team change.
  3. Full re-read only when the position cannot be trusted (the server reports a gap, the app version changed, access changed) or at the daily access renewal.
  4. Never while there are unsynced changes, an open edit form or a call in progress. Updates apply row by row and keep scroll position and selection.
- **Manual "Reload everything"** stays.
- **Removal.** Losing access to an agency deletes that agency's slot. (Problem 20.)

### Part 5. Chat separation (D6, D8 to D12)

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

### Part 6. Lead threads (D9, D16 to D21)

Lead threads are not built yet (the schema has the columns, no request creates them; they arrive with the SMS stage in `messaging-sms-voice.md`). These rules are for when they are.

- **Access follows the lead (D16).** Opening a thread asks "may this person see this lead?" The answer comes from the same rule that already gives tasks and leads only down the team tree, and is remembered for a few seconds. *How the core service decides lead access by team has not been read yet.*
- **One sender (D17).** The assigned agent sends. The team's manager and the owner can read, and can leave internal notes the lead never receives (the database already refuses to send a note by text).
- **Takeover (D17, D18).** A manager or the owner presses "Take over". From then on they send and the agent can only read. Everyone in the thread sees who holds it. The agent can press "Ask for it back", which notifies the holder; only the holder gives it back. The lead sees the same number and the same thread. Inside the app every message shows who really sent it, and each takeover and hand-back is a line in the thread and in the agency's activity record.
- **Reassignment (D19).** Moving the lead moves the thread with all its history. The previous agent stops seeing it at once.
- **Agent leaves (D20, D25, D48).** Their threads go to the team's managers and deputies, or to the owner when the team has none. All are told; the first to act holds the thread and the others see who. The owner can then hand the work on as they choose. This runs in the same step that removes the person from the agency's conversations (roster sync).
- **Unanswered texts (D21, D48).** A reply from a lead waits with the agent as unread. After the agency's wait time (set in the agency's settings, 15 minutes by default, counted in working hours) the team's managers and deputies are notified, and the first to act takes over.
- **Lead ownership (D49).** A lead belongs to one team and one agent of that team. An agent in several teams sees each team's leads under that team; a team's managers never see the agent's leads from another team.

### Part 7. Teams, roles and seats (D43 to D46)

These change rules the authorization service enforces today (`services/authz/tree.go`): exactly one team per caller or closer, at most one manager per team, and a manager who is not also a caller or closer.

- **Managers.** A team has no manager, one, or several with equal rights. A team with no manager is run by the owner.
- **Deputies.** A manager or the owner can name deputies for a team. A deputy can read the team's lead threads and take them over. A deputy cannot invite, change roles, suspend or set limits.
- **Several teams.** A caller or closer can be in more than one team of an agency. The CRM shows a team switch that filters what is on screen. It is a filter, not a lock: an alert for another team's lead still arrives, and opening it switches the view.
- **Several roles.** A person can be a manager and also a closer or caller.
- **Manager rights with several managers.** Any manager of a team can suspend, restrict and set limits for that team's callers and closers, and invite into it. Two managers acting on the same person at once: the later change wins and both are recorded.
- **Seats.** One person in one agency is one seat, whatever their teams and roles.
- **Managers are equal (D64).** Managers of a team cannot suspend, restrict or remove each other; only the owner can.
- **Teams (D65, D66).** Only the owner creates, renames and deletes teams. A team with members or leads cannot be deleted; the owner empties it first with the hand-on screen. This also removes the "team deleted before acceptance" failure for an invitation into a team that still has people.
- **Deputies (D62, D63).** Any member of the agency can be a deputy of a team. The team's managers and the owner name and remove them.
- **Leaving one team (D67).** An agent taken out of one team leaves its leads and threads with that team.
- **"Their manager"** for an agent in several teams means the managers of the team the lead belongs to (D49).
- **Team chat (D52).** Each team has one automatic chat that follows the team's membership. It cannot be deleted while the team exists.
- **Directory (D53, D54).** Every member can see who is in the agency and start a chat with any of them.
- **Reasons and record (D57, D58).** A reason is optional and shown when written. The owner sees the whole record of people changes, managers their teams', each person their own.
- **Coming back (D56).** A removed person can be invited again and starts fresh.
- **Solo to agency (D59).** The same workspace is upgraded; nothing is copied or moved.

### Part 8. Notifications (D39, D40)

- **Categories:** this agency's work; other agencies; personal chats; account and security.
- **Other agencies** carries no details: "New activity in Agency B", plus the badge on the switcher.
- **The notification screen** has Read and Unread tabs, and filters by category.
- **Settings:** each category can be switched off, except account and security (invitations, sign-ins, role changes, suspension, removal).

## Build order

| Step | What | Depends on |
| --- | --- | --- |
| 1 | Invitation fixes that need no new design: agency name, unverified hint, delivery messages, masked address, authenticator explanation, link to the invitation | - |
| 2 | Inviter removed cancels pending invitations; blocked state; held seats; resend and extend | - |
| 3 | Invitations that carry teams; managers inviting into their own teams; leave an agency; remove the old token path | 2 |
| 4 | Tag (`#id`), search rules, and the three settings (phone, find me, message me) | - |
| 5 | Web cache: per-agency slots, layered refresh, delete on removal | - |
| 6 | Personal chats: the second database, personal routes in the messaging service, and tests that try to cross between the two databases in every direction. Roster sync for agency conversations | 4 |
| 7 | Message requests, block, report (90-day copies), limits | 6 |
| 8 | Inbox switch, new-chat search, requests and block screens; per-agency badges in the switcher | 6, 7 |
| 9 | Terms and privacy text for personal chats and reports (needs the lawyer) | before 8 goes live |
| 10 | Lead threads: access by lead, one sender, takeover, reassignment, agent leaving, the unanswered-text wait | the SMS stage, 11 |
| 11 | Teams and roles: several managers, deputies, agents in several teams with the team switch, several roles, seats per person. Changes the authorization rules and every screen that assumes one team | 3 |
| 12 | Hand-on screen for a leaving, removed or suspended person's work; suspension holding | 11 |
| 13 | Owner gone (agency paused) and handing over ownership | - |
| 14 | Notification categories, Read and Unread tabs, per-category settings | 8 |
| 15 | Sign-up inside the invitation link; shared-device choice at sign-in; name and tag change limits | 1, 4, 5 |
| 16 | Automatic team chats, the agency directory, the 15-minute edit window, the record of people changes with its three views | 11 |
| 17 | Solo workspace upgraded in place to an agency | 11 |
| 18 | Plan and billing effects on people: grace period and read-only, choosing who keeps a seat, closing an agency with 30 days to undo, the seat request, payment on handover. *The billing service has not been read yet.* | 12, 13 |
| 19 | Support access granted by the owner for a set time, recorded | - |

Each step ships on its own, with its tests, and is checked in the web app before the next starts.

## Open questions

1. For the lawyer: message retention after account deletion, report copies, and the terms forbidding lead data in personal chats.

## Not verified

- The exact words on the Members screen for creating a team.
- The sign-up path for an invited person with no account yet.
- The platform-staff invitation flow.
- Whether the old token invitation path is still used.
- Whether a removed agency's offline copy is deleted today.
- How the Dashboard's workspace picker behaves with several agencies.
- How the core service decides which team may see a lead (needed for Part 6).
