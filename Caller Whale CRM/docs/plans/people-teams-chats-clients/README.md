# People, teams, chats and clients: the plan

**Written:** 2026-11-16 and 2026-11-17. **State:** plan only, nothing built. Scope is the **web version** (the Dashboard on `callerwhale.com` and the CRM on `app.callerwhale.com`); the desktop (Tauri) app and other local apps are out of scope for now.

This plan began as a review of the invitation flow (`services/auth/invitations.go`, `services/authz/tree.go`, `landing/site/src/AccessManagement.tsx`, `desktop/frontend/react/src/RemoteGate.jsx`) and of messaging (`services/messaging`), and grew through twelve rounds of questions answered by the owner. Everything under "What exists today" was read in the code, not run.

## Files

| File | What it covers |
| --- | --- |
| [01-people-and-invitations.md](01-people-and-invitations.md) | Who can be invited, how an invitation works from sending to arriving, one person in several agencies, the profile, the name tag, and the settings each person controls. |
| [02-teams-and-leads.md](02-teams-and-leads.md) | How teams are built (managers, deputies, admins, agents in several teams), who holds which lead, and how leads move between people and teams. |
| [03-chats.md](03-chats.md) | Personal chats, agency chats and lead threads: how they are kept apart, who can message whom, blocking and reports, takeover of a lead thread, and notifications. |
| [04-clients.md](04-clients.md) | A client is the person or business that hired the agency to work for them. It is not a lead reached by cold calling. This file covers how work is organised by client and what a client sees. |
| [05-calls-and-budgets.md](05-calls-and-budgets.md) | Phone numbers per team, recordings, joining a live call, scripts and the AI's suggestions, call review, commission, and how paid usage is shared and limited. |
| [06-do-not-call.md](06-do-not-call.md) | The three kinds of "do not call", Caller Whale's own database that learns from every agency's work, and who can take a number out. |
| [07-platform-and-rollout.md](07-platform-and-rollout.md) | The web cache, shared devices, what plans and billing do to people, support access, limits on AI, and how every step is released and checked. |

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
| 20 | Leads and teams: moving leads, handoffs inside a team, imports into a team, unassigned leads and claiming, duplicates across teams, agency-wide "Do not call", team reports. *How the core service and the import service hold leads by team has not been read yet.* | 11 |
| 21 | Team phone numbers, the number a moved lead keeps, recordings following the lead, joining a live call by rank. *The dialer service has not been read for this.* | 10, 20 |
| 22 | Budgets: agency pool, optional team budgets, limits set by managers, charging the lead's team, stopping with a request to raise. *The billing and usage code has not been read for this.* | 20 |
| 23 | Clients: every list and lead marked with its client and who supplied it, the "own business" client, the client's view (reports, shared leads, conversation, usage and cost), teams working for several clients. *How client access and sharing work today in the core service has not been read for this.* | 20 |
| 24 | AI limits: the assistant and call helpers reach only what the person can, outside AIs confirm risky steps inside Caller Whale, and nothing spends money without the person. *The assistant and MCP services have not been read for this.* | 11 |
| 25 | "Do not call": the three kinds, Caller Whale's own database learning from every agency, confirmation for registry numbers, the record of who marked what, staff review and removal. *The existing do-not-call code has not been read for this.* | 20 |
| 26 | Scripts per client with a team's own version, the AI's suggestions per lead learned from earlier calls, and call review with feedback. *The assistant and call-helper code has not been read for this.* | 21, 23 |
| 27 | Commission tracking, optional per agency (if it can be built) | 20 |

Each step ships on its own, with its tests, and is checked in the web app before the next starts.

### Order of work

The step numbers above are names, not the order. The order is:

1. Steps 1 and 2: the invitation fixes.
2. Step 11: teams and roles, then step 3 (invitations that carry teams and roles), step 20 (leads and teams), step 12 (hand-on) and step 16 (team chats, directory, record).
3. Step 4: the name tag and settings, with step 15.
4. Step 5: the web cache.
5. Steps 6, 7, 8 and 14: personal chats and notifications, once step 9 (the lawyer's text) is ready.
6. Steps 13, 17, 18 and 19: ownership, solo upgrade, plan effects and support access, after the billing service has been read.
7. Step 10: lead threads, with the SMS stage.
8. Steps 21 and 22: team numbers, live calls and budgets, with the calling and SMS stage, after the dialer and billing services have been read.
9. Steps 23, 24 and 25: clients, AI limits and "do not call", after step 20.
10. Steps 26 and 27: scripts, AI suggestions, call review and commission, last.

Every step goes out behind its own switch (D104) and is tried by the owner before it is on for everyone (D107).

## Open questions

1. For the lawyer: message retention after account deletion, report copies, and the terms forbidding lead data in personal chats.
2. D142: how the AI learns from captions (where it may be used is decided, D146).
3. D144: whether commission tracking can be built.

## Not verified

- The exact words on the Members screen for creating a team.
- The sign-up path for an invited person with no account yet.
- The platform-staff invitation flow.
- Whether the old token invitation path is still used.
- Whether a removed agency's offline copy is deleted today.
- How the Dashboard's workspace picker behaves with several agencies.
- How the core service decides which team may see a lead (needed for Part 6).
- The billing service, the dialer service, the import service, the assistant and MCP services, and the existing do-not-call code, each for the parts of this plan that touch them.

## Every decision

149 decisions. Each row links to the file that holds it.

| # | Decision | File |
| --- | --- | --- |
| D1 | One person can belong to several agencies. This is a supported case. | [01-people-and-invitations](01-people-and-invitations.md) |
| D2 | A person's name, email and other profile details are one profile, shared with every agency they are in. | [01-people-and-invitations](01-people-and-invitations.md) |
| D3 | A personal phone number is shown only if the person chooses to: a setting next to authentication. | [01-people-and-invitations](01-people-and-invitations.md) |
| D4 | The web cache refreshes automatically; a manual reload stays as a fallback. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D5 | Display names get a `#id` tag so two people never look the same in a search. Everyone normally sees the name without the tag. | [01-people-and-invitations](01-people-and-invitations.md) |
| D6 | Chats between people need no agency ("personal chats"). Anything with a lead or a real phone number is locked to one agency, and every participant must be in that agency. | [03-chats](03-chats.md) |
| D7 | When the person who sent an invitation is removed, the invitation is cancelled and gives no access. | [01-people-and-invitations](01-people-and-invitations.md) |
| D8 | The extra protections for personal chats (message requests, block, report, limits) are built with them, not later. | [03-chats](03-chats.md) |
| D9 | A lead thread is reachable only while the person is working inside that agency's workspace. Being a member is required but not enough: from another agency's workspace or from Personal it is not shown, fetched or stored. The thread belongs to the agency. | [03-chats](03-chats.md) |
| D10 | Personal chats are a separate space in the Inbox and live in **their own database**, served by the same messaging service. | [03-chats](03-chats.md) |
| D11 | A stranger can be reached only by their full `Name#id`, and their first message is a request the other person accepts. | [03-chats](03-chats.md) |
| D12 | Platform staff can read reported messages only (with a few before and after for context). Report copies are kept 90 days. | [03-chats](03-chats.md) |
| D13 | Removing an inviter cancels pending invitations only. People who already accepted keep their access. | [01-people-and-invitations](01-people-and-invitations.md) |
| D14 | The tag is generated automatically and the person can change it. | [01-people-and-invitations](01-people-and-invitations.md) |
| D15 | A team manager can invite callers and closers into the teams they run. The owner sees every invitation and can withdraw any. | [01-people-and-invitations](01-people-and-invitations.md) |
| D16 | A lead thread follows the lead: whoever may see the lead may see its thread (the assigned agent, that team's manager, the agency owner). | [03-chats](03-chats.md) |
| D17 | In a lead thread one agent sends. The manager and owner read, leave internal notes, and can **take over** to send in the agent's place. | [03-chats](03-chats.md) |
| D18 | After a takeover the manager or owner hands control back. The agent can ask for it back; they cannot take it. The lead sees no change. | [03-chats](03-chats.md) |
| D19 | A lead moved to another agent or team takes its thread and full history with it. The previous agent loses the thread. | [03-chats](03-chats.md) |
| D20 | When an agent leaves or is removed, their lead threads go to the team's manager (to the owner if the team has none). | [03-chats](03-chats.md) |
| D21 | A lead's unanswered text waits with the agent; after a time each agency sets (15 minutes by default) the team's manager is told and can take over. | [03-chats](03-chats.md) |
| D22 | Platform staff see a member's phone only through the person's own setting. | [01-people-and-invitations](01-people-and-invitations.md) |
| D23 | An agency owner cannot read the agency's internal chats they are not in. Lead threads are different and always visible to the owner. | [03-chats](03-chats.md) |
| D24 | Agency chats cannot be blocked. A member can mute, archive or hide them. Blocking is for personal chats. | [03-chats](03-chats.md) |
| D25 | A person can leave an agency at once. Their leads, tasks and threads go to their managers (or the owner), and the owner can then decide where it goes: all of it to one person, or parts to different people. The same choice applies when someone is removed. | [01-people-and-invitations](01-people-and-invitations.md) |
| D26 | A suspended person's leads and threads are held by their managers, who can read and take over. On restore everything not reassigned returns to the person. | [01-people-and-invitations](01-people-and-invitations.md) |
| D27 | If an owner's account is closed or disabled, the agency is paused (members read, nobody works) and Caller Whale staff hand it on or close it. | [01-people-and-invitations](01-people-and-invitations.md) |
| D28 | An active owner can hand the agency to a member. Both confirm with a second step; the old owner becomes a manager or leaves. | [01-people-and-invitations](01-people-and-invitations.md) |
| D29 | Name and tag changes are limited (for example twice in 30 days). An old `Name#id` is reserved for 90 days so nobody can pose as its last holder. | [01-people-and-invitations](01-people-and-invitations.md) |
| D30 | New accounts start with: people in my agencies find me by name; anyone else needs my exact `Name#id` and sends a request. | [01-people-and-invitations](01-people-and-invitations.md) |
| D31 | A blocked person is told ("You cannot message this person"). | [03-chats](03-chats.md) |
| D32 | In a shared personal group, a blocker and the blocked both stay; each one's messages are hidden from the other and can be shown on demand. Nobody else is told. | [03-chats](03-chats.md) |
| D33 | A block covers personal chats only. Work chats between the same two people in a shared agency continue; the blocker is told this when blocking. | [03-chats](03-chats.md) |
| D34 | A block closes every route: direct message, request, search, and being added to a group together. A new account made to get around a block is abuse. | [03-chats](03-chats.md) |
| D35 | Unblocking brings the old conversation back. Messages attempted during the block were never delivered and do not appear. | [03-chats](03-chats.md) |
| D36 | Personal chats allow what agency chats allow (text, replies, reactions, polls, GIFs, and photos and files when built), minus the lead card and lead location. | [03-chats](03-chats.md) |
| D37 | When an account is deleted its messages stay for the others, shown as "Deleted user". Agency chats and lead threads stay with the agency. | [03-chats](03-chats.md) |
| D38 | At sign-in the person chooses "This is my device" (the encrypted copy is kept) or "Shared device" (nothing is kept after sign-out or closing the tab). | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D39 | Activity in an agency the person is not working in shows as a badge on the switcher and as a notification in its own category, with no details. | [03-chats](03-chats.md) |
| D40 | Notifications have categories: this agency's work, other agencies, personal chats, account and security. The notification screen has Read and Unread tabs. Each person can switch a category off, except account and security. | [03-chats](03-chats.md) |
| D41 | Each agency sets how long its invitations stay valid. | [01-people-and-invitations](01-people-and-invitations.md) |
| D42 | An agency cannot limit or hide its members' personal chats. | [03-chats](03-chats.md) |
| D43 | A team can have no manager, one, or several equal managers. Each manager can also name deputies, who can read and take over threads but not invite or change people. | [02-teams-and-leads](02-teams-and-leads.md) |
| D44 | A caller or closer can be in several teams of one agency and switches the view to the team they want to work in. The switch is a filter, not a lock: alerts for another team's lead still arrive, and opening one switches the view. | [02-teams-and-leads](02-teams-and-leads.md) |
| D45 | One person can hold several roles in an agency, for example a manager who also closes. One invitation can carry them. | [02-teams-and-leads](02-teams-and-leads.md) |
| D46 | A seat is one person in one agency, however many teams or roles they have. The same person in two agencies is one seat in each. | [02-teams-and-leads](02-teams-and-leads.md) |
| D47 | An invitation link lets a new person sign up inside it: email filled in and locked, opening the link confirms the email, and they land in the agency. | [01-people-and-invitations](01-people-and-invitations.md) |
| D48 | When a team has several managers, all of them and their deputies are told about an agent's handed-on threads and unanswered texts. The first to act holds it and the others see who. | [03-chats](03-chats.md) |
| D49 | A lead belongs to one team and is assigned to one agent of that team. That team's managers see it; the agent's other teams do not. | [02-teams-and-leads](02-teams-and-leads.md) |
| D50 | After reviewing a report, staff can warn the person, limit their personal chats for a period, suspend the account, or dismiss. A suspension applies across Caller Whale; each affected agency owner is told the member is suspended, not why. | [03-chats](03-chats.md) |
| D51 | Clients and partners see only the partner threads shared with them inside an agency, and have a Personal space like anyone else. | [03-chats](03-chats.md) |
| D52 | Every team gets its own team chat automatically. Managers, deputies and agents join and leave it as they join and leave the team. | [03-chats](03-chats.md) |
| D53 | Inside an agency, any member can start a chat with any other member. | [03-chats](03-chats.md) |
| D54 | Every member sees who is in the agency, with role and team. Contact details follow each person's own settings. | [02-teams-and-leads](02-teams-and-leads.md) |
| D55 | A message can be edited for 15 minutes (marked "edited") and deleted at any time (leaving "Message deleted"). A text already sent to a lead cannot be edited or unsent. | [03-chats](03-chats.md) |
| D56 | A removed person can be invited back and starts fresh: nothing assigned, old chats only where they are added again. The owner sees they were a member before. | [01-people-and-invitations](01-people-and-invitations.md) |
| D57 | A reason for a removal or suspension is optional. If one is written, the person sees it. | [01-people-and-invitations](01-people-and-invitations.md) |
| D58 | The record of people changes: the owner sees all of it, managers see their teams', each person sees changes made to themselves. | [01-people-and-invitations](01-people-and-invitations.md) |
| D59 | A solo operator who adds callers upgrades in place: the same workspace becomes an agency and keeps its leads, clients and history. | [02-teams-and-leads](02-teams-and-leads.md) |
| D60 | Personal chats start with: 20 new people a day, 5 pending requests at a time, 30 messages a minute, groups up to 50 people. | [03-chats](03-chats.md) |
| D61 | Reports are reviewed by the platform owner and cofounder only, with a second step, and every look is recorded. | [03-chats](03-chats.md) |
| D62 | A deputy can be any member of the agency. Being a deputy shows that team's leads to them. | [02-teams-and-leads](02-teams-and-leads.md) |
| D63 | A team's managers and the owner name and remove its deputies. The owner sees every change. | [02-teams-and-leads](02-teams-and-leads.md) |
| D64 | Managers of a team cannot act on each other. Only the owner can. | [02-teams-and-leads](02-teams-and-leads.md) |
| D65 | Only the owner creates, renames and deletes teams. | [02-teams-and-leads](02-teams-and-leads.md) |
| D66 | A team can be deleted only when it has no members and no leads. The owner moves them first with the hand-on screen. | [02-teams-and-leads](02-teams-and-leads.md) |
| D67 | An agent taken out of one of their teams leaves that team's leads and threads with the team; its managers reassign them. The agent keeps their other teams' work. | [02-teams-and-leads](02-teams-and-leads.md) |
| D68 | The invited person can decline. The sender sees "Declined" and the seat is freed at once. | [01-people-and-invitations](01-people-and-invitations.md) |
| D69 | One person can own several agencies, each with its own plan, seats, teams and data. | [01-people-and-invitations](01-people-and-invitations.md) |
| D70 | Handing over ownership completes only after the new owner adds their own payment method. The old owner's card is removed and never charged again. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D71 | A manager inviting with no free seat is blocked and can send the owner a request to add one. Nothing is charged without the owner. | [01-people-and-invitations](01-people-and-invitations.md) |
| D72 | Agency chats always show read status and online status. In personal chats each person chooses; hiding yours hides others' from you. | [03-chats](03-chats.md) |
| D73 | A personal group has an owner (its creator) who can name admins. Owner and admins add and remove people; anyone can leave. Someone added by a person they do not know gets a request first. | [03-chats](03-chats.md) |
| D74 | Each agency has an announcements channel with every member in it. Only the owner and managers post; everyone can react. Posts marked important cannot be muted. | [03-chats](03-chats.md) |
| D75 | An agency's internal chat messages are kept while the agency exists. Lead threads follow the lead's record and the legal rules for texts. | [03-chats](03-chats.md) |
| D76 | Takeover follows rank: owner over manager, manager over deputy, deputy over agent. Control is handed back down the same way. | [03-chats](03-chats.md) |
| D77 | If the holder of a taken-over thread does not answer a new text within the agency's wait time, control returns to the agent and both are told. | [03-chats](03-chats.md) |
| D78 | An agent in several teams opens on the last team used, and has an "All my teams" view where each lead is marked with its team. | [02-teams-and-leads](02-teams-and-leads.md) |
| D79 | The owner sets the agency's working hours and time zone. A team can have its own hours. They control the unanswered-text wait. | [03-chats](03-chats.md) |
| D80 | When payment fails or the plan ends, a grace period (7 days to start) keeps everything working and warns the owner. After it, members can read but not work and invitations stop, until the owner pays. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D81 | Lowering the plan below the number of members cannot complete until the owner picks who keeps a seat. The others are suspended, not removed, and their work is handed on. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D82 | Closing an agency: members lose access at once and are told. The owner can reopen it for 30 days and export the data. Then it is deleted, except what the law requires keeping. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D83 | Caller Whale staff can open an agency's workspace only when its owner allows it, for a set time (24 hours to start). They do not see internal chats, every action is recorded, and the owner can end it early. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D84 | Outside the app, notifications can reach a person by browser notification, by email for important things (invitations, security, an unanswered lead text), and by a daily email digest. Each can be switched off; a person can choose nothing outside the app. A browser notification shows no lead details. | [03-chats](03-chats.md) |
| D85 | Each person can set quiet hours. Account and security alerts still come through. Work alerts also pause outside the agency's working hours. | [03-chats](03-chats.md) |
| D86 | Agency chats have `@person`, `@team`, `@everyone` and `@managers`. In large groups and announcements only the owner and managers can use `@everyone`. | [03-chats](03-chats.md) |
| D87 | People can search message text, only in conversations they belong to and only in the space they are in (one agency, or Personal). Never across agencies. | [03-chats](03-chats.md) |
| D88 | Personal chats have automatic protection: someone whose requests are mostly declined or reported is slowed down, then limited until staff review. It works from counts, not from reading messages. | [03-chats](03-chats.md) |
| D89 | A person limited or suspended after a report can appeal once. A different reviewer decides (for now, whichever of the owner and cofounder did not make the first decision). | [03-chats](03-chats.md) |
| D90 | A link from someone not yet accepted shows a warning before it opens. When files are built, only common safe types are allowed and they are scanned. | [03-chats](03-chats.md) |
| D91 | A "My access" page lists every agency the person belongs to with role and teams, pending invitations, signed-in devices, and a Leave button per agency. | [01-people-and-invitations](01-people-and-invitations.md) |
| D92 | Every invitation shows the agency's name, when it was created, and the owner's full `Name#id`, with a "Report this invitation" button that goes to staff. New agencies need no approval. | [01-people-and-invitations](01-people-and-invitations.md) |
| D93 | Pending invitations cannot exceed the agency's free seats, and there is a daily cap. A person can block an agency so it can never invite them again, and report it. | [01-people-and-invitations](01-people-and-invitations.md) |
| D94 | The owner invites any client or partner. A manager can invite a client only to share things belonging to their own teams. | [04-clients](04-clients.md) |
| D95 | Managers and deputies must have an authenticator set up, like owners. They are asked for a code at sign-in, not at every action. | [01-people-and-invitations](01-people-and-invitations.md) |
| D96 | Internal notes in a lead thread are read and written by everyone who can see the thread, and move with it on reassignment. | [03-chats](03-chats.md) |
| D97 | An agent can be in at most 5 teams of an agency (a starting number). | [02-teams-and-leads](02-teams-and-leads.md) |
| D98 | With several roles, including an agency's custom roles, a person can do what any of their roles allows. A restriction placed on the person always wins over a role. | [02-teams-and-leads](02-teams-and-leads.md) |
| D99 | A person can download their profile, settings and personal chats. Agency data belongs to the agency and is exported by its owner. | [01-people-and-invitations](01-people-and-invitations.md) |
| D100 | An owner can name admins. An admin can do everything the owner can with people, teams and settings, but cannot change the plan, hand over or close the agency, or remove the owner. Wherever this plan says "the owner" for people, teams and settings, an admin can too. | [02-teams-and-leads](02-teams-and-leads.md) |
| D101 | The owner and admins can be assigned leads in any team without being added to it, and then take a seat like anyone who works leads. | [02-teams-and-leads](02-teams-and-leads.md) |
| D102 | Handing on a person's work covers their leads and lead threads, open tasks and callbacks (due times kept), open deals at their stage, and notes (which stay on the lead). Unsent drafts are discarded. | [02-teams-and-leads](02-teams-and-leads.md) |
| D103 | The first thing built after the two invitation steps is teams and roles. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D104 | Each step has its own switch: on for the owner's agency first, then for everyone, and off again without a new release if something is wrong. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D105 | Personal chats go live after teams and the name tag, once the lawyer's text is ready. The server's memory is checked before the second database is created. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D106 | Existing people learn about their tag from a one-time note in settings. No email. | [01-people-and-invitations](01-people-and-invitations.md) |
| D107 | Each step is checked by automatic tests and in the web app, then tried by the owner in their own agency with a second account, before it is switched on for everyone. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D108 | The owner and admins move a lead between any teams. A manager moves a lead only between teams they run. | [02-teams-and-leads](02-teams-and-leads.md) |
| D109 | A handoff from a caller to a closer stays inside one team. Sending a lead to another team's closer is a team move (D108). | [02-teams-and-leads](02-teams-and-leads.md) |
| D110 | An imported list belongs to the team chosen at import. The person importing picks a team they belong to or run; the owner and admins can import into any team. The leads start unassigned in that team. | [02-teams-and-leads](02-teams-and-leads.md) |
| D111 | Managers and deputies hand out a team's unassigned leads. Each team has a setting for whether its agents may also claim them. | [02-teams-and-leads](02-teams-and-leads.md) |
| D112 | When the same person or property is imported into a second team, that team sees "This lead already exists in another team" without the details. The owner or an admin chooses which team keeps it, or that both keep their own copy. | [02-teams-and-leads](02-teams-and-leads.md) |
| D113 | "Do not call" applies to the whole agency: the number is blocked for every team and for future imports. Only the owner or an admin can lift it. | [06-do-not-call](06-do-not-call.md) |
| D114 | A manager who runs several teams gets the same team switch and "All my teams" view as agents (step 11). | [02-teams-and-leads](02-teams-and-leads.md) |
| D115 | A manager sees reports for the teams they run. Agency-wide totals and other teams' numbers are for the owner and admins. | [02-teams-and-leads](02-teams-and-leads.md) |
| D116 | Each team has its own phone numbers, given by the owner or an admin. A team without one uses the agency's default number. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D117 | A lead that moves to another team keeps the number it already knows, so replies still arrive. New leads of a team use that team's number. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D118 | Call recordings and transcripts are open to the same people as the lead thread, and move with the lead. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D119 | A manager or deputy can join an agent's live call: listen silently, speak only to the agent, or take the call over, by rank as in D76. The agent always sees that someone joined. Whether the lead must be told depends on the law where they are. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D120 | Paid usage (texts, call minutes, skip tracing credits) comes from the agency's allowance. The owner or an admin can give a team a monthly budget; a team without one draws from the pool. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D121 | A manager sets usage limits for their team's agents, within the team's budget. The owner and admins set anyone's. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D122 | A text or call is charged to the team that owns the lead, whoever sends it, including a takeover. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D123 | When a team's budget or a person's limit runs out, paid actions stop for them and they can ask the manager or owner to raise it. Replies from leads still arrive and can be read. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D124 | By default an agent sees only their own leads. Each team can switch on "agents see the whole team's leads", read-only. | [02-teams-and-leads](02-teams-and-leads.md) |
| D125 | A team's managers can switch on a leaderboard for the team. Without it, each agent sees only their own numbers. | [02-teams-and-leads](02-teams-and-leads.md) |
| D126 | Every list and lead belongs to a client. A list is marked at import with the client it is for and with who supplied it: the client, or the agency. An agency working only for itself has one built-in "own business" client. | [04-clients](04-clients.md) |
| D127 | A client who signs in sees: results and reports for their work (no names or phone numbers), the leads or briefs the agency shared with them, a conversation with the agency, and the usage and cost of their work. | [04-clients](04-clients.md) |
| D128 | A team can work for several clients. A lead carries both a team and a client. The team's agents see leads of every client the team works for; a client never sees the agency's other clients. | [04-clients](04-clients.md) |
| D129 | The in-app AI assistant reaches exactly what the person can: same agency, same teams, same leads, never more. It works only in the agency the person is currently in and never in personal chats. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D130 | An outside AI (ChatGPT, Claude, Gemini) connected through MCP can read and set things up for a person within that person's own rights. Inviting, removing, changing roles and deleting each need the person's confirmation inside Caller Whale. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D131 | Spending money always needs the person themselves, in Caller Whale. No AI, in-app or outside, can spend, raise a budget or change a plan, and there is no way around it. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D132 | When a client stops working with the agency, lists the client supplied are exported to them and removed from the agency after a set time. Lists the agency supplied stay with the agency, no longer marked with that client. | [04-clients](04-clients.md) |
| D133 | The same person or property in two clients' lists is two separate records with separate histories. Neither client can learn the other has it. The owner and admins see a quiet marker that it exists twice. | [04-clients](04-clients.md) |
| D134 | The agency invites a client's main contact. That person adds and removes their own colleagues, who see the same client view. All are free seats. | [04-clients](04-clients.md) |
| D135 | The owner or an admin sets a monthly budget per client. A text or call counts against both the lead's client and the lead's team. The client sees their own usage. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D136 | A client hears a recording or reads a conversation only when the owner, an admin or the lead's team managers share that specific one. | [04-clients](04-clients.md) |
| D137 | Each client has one conversation with the people the agency names for them: the owner, admins and chosen managers. Agents are in it only if added. | [04-clients](04-clients.md) |
| D138 | The agency can send the calling script and the list summary to the client for approval. Whether approval is required before work starts is a setting per client. | [04-clients](04-clients.md) |
| D139 | "Do not call" has three kinds. **Asked this agency to stop:** blocked for that agency, every client and team. **On a registry or a known complainer:** added to Caller Whale's own database for every agency once confirmed (a second agency reports it, or staff check it). **Wants no calls at all:** added to Caller Whale's database for every agency. | [06-do-not-call](06-do-not-call.md) |
| D140 | Any number found to be a do-not-call number that is not yet in Caller Whale's database is added to it. The database learns from every agency's work. | [06-do-not-call](06-do-not-call.md) |
| D141 | Only Caller Whale staff remove a number from the database. An agency can ask for a review with a reason; each removal is recorded. | [06-do-not-call](06-do-not-call.md) |
| D142 | Calling scripts belong to a client, written by the owner, admins or the managers working for that client. A team can keep its own version; agents cannot change scripts. The AI also suggests what to say for each lead, from the lead's data and from earlier calls: captions run in the background of every call, and the AI learns from how the previous calls went to help with the next one. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D143 | A manager or deputy can score a call recording against a short checklist and leave comments. The agent sees their own scores; the team's averages go into the manager's reports. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D144 | Commission tracking, if it can be built, is optional per agency: the owner sets rates and Caller Whale shows what each agent has earned. No payments are made through it. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D145 | The plan is kept in one folder: an index of every decision, and one file per area. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D146 | What the AI learns from an agency's calls is used only inside that agency, and what it learns from one client's calls only for that client's work. Nothing crosses to another agency. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D147 | Each agency sets how long call recordings and captions are kept, inside limits Caller Whale sets after the lawyer's review. Captions used for AI learning are deleted with the recording. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D148 | The owner switches the AI's call suggestions on for the agency, and a team's managers for the team. An agent can hide the suggestions on their own screen, but cannot turn off captions if the agency requires them. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D149 | If commission tracking is built, the owner sets the rules per role or person (for example a fixed amount per appointment for callers and a percentage of the deal for closers, with a split when both worked the lead) and can override any figure. | [05-calls-and-budgets](05-calls-and-budgets.md) |
