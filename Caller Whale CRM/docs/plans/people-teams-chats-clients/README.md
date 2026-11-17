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
- The web CRM keeps its data in the open tab only, with no device password (since commit `959c2bf3`, 2026-11-10). The desktop app still keeps an encrypted copy behind a device password (`remote/vault.ts`). Switching agencies reloads everything.

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
20. *Closed:* the web app saves no copy, so there is nothing to delete. (The desktop app is out of scope.)
21. When someone is removed from an agency, their rows in that agency's chats stay: others still see them as a member and live prompts still go to them. Their access to read is refused, but the list is wrong.

## Build order

| Step | What | Depends on |
| --- | --- | --- |
| 1 | Invitation fixes that need no new design: agency name, unverified hint, delivery messages, masked address, authenticator explanation, link to the invitation | - |
| 2 | Inviter removed cancels pending invitations; blocked state; held seats; resend and extend | - |
| 3 | Invitations that carry teams; managers inviting into their own teams; leave an agency; remove the old token path | 2 |
| 4 | Tag (`#id`), search rules, and the three settings (phone, find me, message me) | - |
| 5 | Web cache in the open tab: one agency in memory, layered automatic refresh, cleared on losing access | - |
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
| 28 | Pipeline stages per agency and client; closers' availability, booking by callers, ranges set by managers; deal credit by role; Google Calendar per account (busy times read, appointments written, no lead details in events, removed on leaving). *The calendar and deals code has not been read for this, and Google's access needs its own review.* | 20, 23 |
| 29 | Email from the agency's or a client's sending domain, with replies returning to the lead's record. *The mail code has not been read for this.* | 23 |
| 30 | Protecting an agency's leads: who can export, masked phone numbers for agents, a warning and slow-down on unusual access, and a record of who opened each lead. *Honest limit: a number an agent may call can still be written down by hand.* | 20 |
| 31 | First setup for a new agency (guided, skippable, with a checklist), a walk-through per role, and agency material that managers assign. *The learning service has not been read for this.* | 11, 23 |
| 32 | Overviews by role (owner: what needs them today; team lead: their team right now), scheduled report emails with totals only, reports in the agency's time zone. *The current overview and reports code has not been read for this.* | 20, 22, 23 |
| 33 | Keys for outside tools (limited, switchable, recorded, never spending) and outgoing events with no lead details. *The gateway's token handling has not been read for this.* | 23, 24 |
| 34 | Public status page, outage banner and owner emails; the breach notice process (a written procedure as much as code). | - |
| 35 | Sign-in with Google, Microsoft and Apple; an agency requiring an authenticator for everyone; recovery needing the email link and a second proof; seeing and ending sessions, including an owner ending a member's. *Partly exists in the auth service (Firebase sign-in, authenticator, recovery codes); not read in detail for this.* | 11 |
| 36 | Website forms per client: link or embed, submissions become leads in a chosen team, block-list check, consent recorded. *For the lawyer: the consent wording.* | 23, 25 |
| 37 | Sending a lead to another agency: owner or admin sends and accepts, contact details and a note travel, the sender keeps a closed copy and sees the outcome, blocks travel with it. | 20, 25 |
| 38 | Files on leads: upload by whoever holds the lead, sharing by team leads and above, scanning, size and type limits, storage against the plan, tracked shared links that expire. *No file storage exists for leads yet as far as this plan has read.* | 23 |
| 39 | Carrier registration per agency (10DLC brand and campaign), calling and texting opened only after approval, agency complaint and opt-out rates with warn-limit-suspend, the staff view across agencies. *The dialer and SMS provider's registration API has not been read; carrier approval takes days to weeks and is outside our control.* | 21 |

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
11. Steps 28 and 29: pipeline, appointments, Google Calendar and email sending, after step 23.
12. Step 30: protecting leads, straight after step 20, since it guards the same data.
13. Step 31: first setup and walk-throughs, last, once the screens they describe exist.
14. Step 32: overviews and reports, once the things they count exist.
15. Steps 33 and 34: integrations, the status page and the breach procedure. Step 34 can be done at any time; it must exist before opening.
16. Step 35: sign-in options and sessions, alongside step 15.
17. Steps 36 and 37: website forms and sending leads between agencies, after steps 23 and 25.
18. Step 38: files on leads, with or after step 23.
19. Step 39: carrier registration and agency policing, before any real agency texts. Like the lawyer and Google, carrier approval takes calendar time, so it should start early.

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
- How the Dashboard's workspace picker behaves with several agencies.
- How the core service decides which team may see a lead (needed for Part 6).
- The billing service, the dialer service, the import service, the assistant and MCP services, and the existing do-not-call code, each for the parts of this plan that touch them.

## Every decision

291 decisions. Each row links to the file that holds it.

| # | Decision | File |
| --- | --- | --- |
| D1 | One person can belong to several agencies. This is a supported case. | [01-people-and-invitations](01-people-and-invitations.md) |
| D2 | A person's name, email and other profile details are one profile, shared with every agency they are in. | [01-people-and-invitations](01-people-and-invitations.md) |
| D3 | A personal phone number is shown only if the person chooses to: a setting next to authentication. | [01-people-and-invitations](01-people-and-invitations.md) |
| D4 | The web cache refreshes automatically; a manual reload stays as a fallback. The cache lives in the open tab only (D194). | [07-platform-and-rollout](07-platform-and-rollout.md) |
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
| D38 | At sign-in the person chooses "This is my device" (their sign-in is remembered, D188) or "Shared device" (they are signed out when the tab closes). On the web no lead data is ever saved in the browser either way (D194). | [07-platform-and-rollout](07-platform-and-rollout.md) |
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
| D150 | When a lead calls back, it rings the agent assigned to that lead. If they are busy or away it rings the team's other available agents, then its managers, then goes to voicemail in the lead's thread. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D151 | Calls and texts are blocked outside the allowed hours in the lead's own time zone. Caller Whale sets the legal window by the lead's location; an agency can make it shorter, never longer. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D152 | Agents have a status: available, on a call (automatic), on a break, off (set by the agent). Inbound calls, unanswered-text alerts and assignments use it, and managers see their team's status. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D153 | A callback that comes due while its agent is away stays with the agent, flagged overdue. After the agency's wait time the team's managers and deputies are told and can give that one call to someone else. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D154 | The owner or an admin sets the agency's pipeline stages. A client's work can have its own stages when it needs them. Teams and agents cannot change stages. | [02-teams-and-leads](02-teams-and-leads.md) |
| D155 | Closers have availability for appointments. A caller of the same team sees the free slots and who is responsible for each, and books one; the closer is notified and it appears on their calendar. If the closer is live on the call with the caller, they can help set the right time during it. | [02-teams-and-leads](02-teams-and-leads.md) |
| D156 | A closer manages their own free slots. The team's managers, admins and the owner can also set or limit the range of slots for a closer. | [02-teams-and-leads](02-teams-and-leads.md) |
| D157 | A closed deal is credited to everyone who worked it, by role: the caller who set it and the closer who closed it, with the team and the client. Reports and any commission use those records. | [02-teams-and-leads](02-teams-and-leads.md) |
| D158 | A person can connect their Google Calendar to their account. Caller Whale reads only when they are busy, not what the events are, so those slots are not offered, and adds Caller Whale appointments to their calendar. | [02-teams-and-leads](02-teams-and-leads.md) |
| D159 | A Google Calendar event for an appointment holds the time and a link back that opens the lead inside the right agency. Names and phone numbers stay in Caller Whale, so a personal calendar never holds an agency's lead data. | [02-teams-and-leads](02-teams-and-leads.md) |
| D160 | When a person leaves an agency, that agency's events are removed from their Google Calendar, and the appointments go to whoever receives their leads and appear on that person's calendar. | [02-teams-and-leads](02-teams-and-leads.md) |
| D161 | Email to a lead is sent from the agency's own sending domain, or from one connected for a client. Replies come back into the lead's record, not to a personal inbox. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D162 | The owner and admins can export any leads. A manager can export their own teams' leads only if the owner switches that on. Agents never export. Every export is recorded with who, what and when. | [02-teams-and-leads](02-teams-and-leads.md) |
| D163 | By default agents see only the last digits of a lead's phone number and call or text with a button. The owner can switch full numbers on per team. Managers and above always see them. | [02-teams-and-leads](02-teams-and-leads.md) |
| D164 | When a person opens or scrolls through far more leads than usual, the owner and admins are told and that person is slowed for a while. Nothing is blocked outright. | [02-teams-and-leads](02-teams-and-leads.md) |
| D165 | Each lead keeps a record of who opened it and when, visible to the owner and admins, kept for a set time. | [02-teams-and-leads](02-teams-and-leads.md) |
| D166 | Everything in this plan is built before Caller Whale is opened to agencies. There is no smaller first release. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D167 | Until then the only people using it with real leads are the owner and a couple of friends. Each step that changes teams, roles or leads carries their existing people and data across, and they are told before it is switched on. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D168 | Every new screen works at phone width, as the CRM already does. A separate mobile app is not part of this plan. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D169 | Within building it all, the owner marked these as mattering most after the invitation fixes and teams and roles: leads by team and protecting leads, clients, the name tag and personal chats, and the web cache for several agencies. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D170 | A new agency owner meets a short guided setup: agency name and hours, first team, first client (or "own business"), inviting people, and the authenticator. Each step can be skipped and finished later from a checklist. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D171 | The app ships in English. New screens keep their words separate from the code so another language can be added later without rework, including right-to-left layout. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D172 | The client's screens, reports and emails show the agency's name and logo, with a small "Powered by Caller Whale". | [04-clients](04-clients.md) |
| D173 | Each role gets a brief walk-through of its own screens on first sign-in. Managers and the owner can assign the agency's own material and see who finished it. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D174 | A cancelled or withdrawn invitation sends no email. The invited person sees "This invitation was cancelled" if they open the link or their dashboard. | [01-people-and-invitations](01-people-and-invitations.md) |
| D175 | An invitation can be resent at most once an hour and three times in total, and extended twice. After that the owner withdraws it and sends a new one. | [01-people-and-invitations](01-people-and-invitations.md) |
| D176 | An agency can never have more pending invitations than free seats, and no more than 50 new ones in a day. Staff can raise the daily number for a large agency. | [01-people-and-invitations](01-people-and-invitations.md) |
| D177 | Someone signed in with a different address than the one invited is shown the first letter and the domain of the invited address, for example m•••••@gmail.com. | [01-people-and-invitations](01-people-and-invitations.md) |
| D178 | On screen the role that runs a team is called "Team lead", and its deputy "Deputy lead". This plan's word "manager" means the team lead; the stored role key stays `manager`. | [02-teams-and-leads](02-teams-and-leads.md) |
| D179 | An agency can have at most 3 admins (a starting number). Staff can raise it for a large agency. | [02-teams-and-leads](02-teams-and-leads.md) |
| D180 | The team switch sits in the header beside the agency name and opens a short list with "All my teams". People in one team see no switch. | [02-teams-and-leads](02-teams-and-leads.md) |
| D181 | When the new team rules are switched on, every existing team keeps its lead and its members exactly as they are. The new abilities are simply available afterwards. | [02-teams-and-leads](02-teams-and-leads.md) |
| D182 | Work waiting to be handed on stays with the team leads, who can work it. The owner and admins get a reminder after a few days that it is still waiting. | [02-teams-and-leads](02-teams-and-leads.md) |
| D183 | Each team sets a maximum of open leads per agent. An agent at the limit cannot claim more until they finish or release some. | [02-teams-and-leads](02-teams-and-leads.md) |
| D184 | The record of people changes is kept 2 years. The record of who opened a lead is kept 90 days. The lawyer may adjust both. | [02-teams-and-leads](02-teams-and-leads.md) |
| D185 | A member can mute the automatic team chat but cannot leave it while they are in the team. | [03-chats](03-chats.md) |
| D186 | A tag is 4 letters and digits, for example #K7P2. Characters that are easily confused (0 and O, 1 and I) are never used. A person changing theirs picks 3 to 8 characters from the same set. | [01-people-and-invitations](01-people-and-invitations.md) |
| D187 | The tag appears beside a name only when the same name occurs twice in what is on screen. Otherwise names stay clean. | [01-people-and-invitations](01-people-and-invitations.md) |
| D188 | "This is my device" is remembered for 30 days. Owners, admins and team leads are asked for their authenticator code again every 7 days. A sign-in from a new place asks at once. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D189 | *Replaced by D194.* (It assumed the web app still saved an encrypted copy behind a device password; that was removed on 2026-11-10.) | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D190 | Before accepting a message request the receiver sees the sender's name, tag and first message as plain text: links are not clickable and pictures are not shown. The sender cannot tell whether it was opened. | [03-chats](03-chats.md) |
| D191 | An unanswered message request is removed quietly after 30 days. The sender can send one new request to the same person after another 30 days. | [03-chats](03-chats.md) |
| D192 | A declined request looks the same to the sender as one still waiting. A decline counts toward the automatic spam protection. | [03-chats](03-chats.md) |
| D193 | A report in personal chats has four reasons: spam or scam, harassment or threats, sharing an agency's lead data, pretending to be someone else. | [03-chats](03-chats.md) |
| D194 | The web app saves no lead data in the browser and asks for no device password (as built on 2026-11-10). Its cache lives in the open tab and is gone on reload. The desktop app keeps its encrypted copy and device password, and is out of scope. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D195 | The report queue shows "harassment or threats" first, then everything else oldest first. A person with several open reports appears once, with all of them together. | [03-chats](03-chats.md) |
| D196 | Threat reports are looked at within a day and others within 3 days. A report waiting longer sends the owner and cofounder an email reminder. The reporter is told when it is reviewed. | [03-chats](03-chats.md) |
| D197 | Notifications older than 90 days, read or unread, are removed. What they pointed to is never affected. | [03-chats](03-chats.md) |
| D198 | Many notifications of the same kind at once are grouped into one line ("40 leads were assigned to you") that opens the list, with one browser pop-up for the group. | [03-chats](03-chats.md) |
| D199 | An ownership handover lapses if the new owner has not confirmed and added payment within 7 days; nothing changes. The old owner can cancel it at any time before then. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D200 | In a handover the old owner chooses their new role: admin, team lead, or leaving. The new owner can change it afterwards like anyone else's. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D201 | When an owner's account is disabled, only an existing admin of the agency can ask to take it over. Staff confirm the owner cannot be reached for 14 days and check the request before handing it over. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D202 | With support access granted, staff can see screens and change settings to fix a problem. They cannot edit, export or delete leads, message anyone, or spend money. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D203 | When a solo operator upgrades, a first team named after them is created, they become its team lead as well as the owner, and all their leads go into it. Their clients stay as clients of the agency. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D204 | During the grace period after a failed payment, only the owner and admins are told, by a daily email and an in-app banner. Members see a plain notice only once the agency is read-only. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D205 | A read-only agency can be read, and replies from leads still arrive and are stored. Nothing can be sent, called, imported or exported, and no one can be invited. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D206 | After 30 days of read-only with no payment, the agency is treated as closed (D82): members lose access, and the owner can still pay and reopen, or export, for 30 more days. Then it is deleted except what the law requires keeping. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D207 | A reply that is only an opt-out ("STOP", "unsubscribe", "stop texting me") blocks the number for that agency at once, sends an automatic confirmation, and the thread shows why. The agent cannot override it; only the owner or an admin can, with a reason. | [06-do-not-call](06-do-not-call.md) |
| D208 | A message that uses "stop" inside a normal sentence ("let's stop at that price") is flagged to the agent, with the AI's reading of whether it is an opt-out. The agent must choose "opt-out" or "not an opt-out" before sending anything else, and the choice is recorded. | [06-do-not-call](06-do-not-call.md) |
| D209 | An opt-out says what it stops: "stop texting me" blocks texts, "stop calling me" blocks calls, "stop" or "leave me alone" blocks both. When unclear, both are blocked. | [06-do-not-call](06-do-not-call.md) |
| D210 | The owner, admins and team leads write text templates per client or team, with fields such as the lead's first name. Agents pick one and can edit it before sending. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D211 | A text can be scheduled. It is sent only inside the lead's allowed hours and is cancelled automatically if the number is blocked before then. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D212 | Only the owner, admins and team leads can send one message to many leads, within budgets and calling hours. Each lead still gets their own thread. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D213 | Each number is checked (mobile, landline, disconnected) the first time it is about to be used, paid from the budget. Landlines are not texted, disconnected numbers are marked, and the result is kept so a number is never paid for twice. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D214 | A lead not contacted for a long time (6 months to start) has its number checked against the reassigned-numbers database before the next contact. The lawyer confirms which countries need it. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D215 | When someone answers "wrong number", the number is removed from that lead and blocked for anyone tied to it. The lead stays, waiting for a new number. The person who answered is not added to anything. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D216 | The owner and admins see a health score for each sending number. A number starting to be flagged as spam is slowed automatically and the owner is told, before carriers block it. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D217 | Every imported number is checked against the agency's do-not-call list, Caller Whale's own database and any registry the agency subscribes to, before any calls start. Blocked rows are kept but marked, and the import summary says how many. | [02-teams-and-leads](02-teams-and-leads.md) |
| D218 | The checks at import are charged to the client the list is for and to the team it goes to. When there is no client budget, the agency's own allowance pays. The import shows the cost before it starts. | [02-teams-and-leads](02-teams-and-leads.md) |
| D219 | The person who imported a list, or a team lead, can remove the whole list within 24 hours if none of its leads has been called, texted or edited. After that, leads are removed one by one. | [02-teams-and-leads](02-teams-and-leads.md) |
| D220 | One import can be as large as the agency's remaining lead allowance. Large files are read in parts and the person can keep working meanwhile. | [02-teams-and-leads](02-teams-and-leads.md) |
| D221 | The owner, admins and team leads can run skip tracing. An agent can ask for a lead to be traced, and a team lead approves. It is paid from the lead's client and team budget. | [02-teams-and-leads](02-teams-and-leads.md) |
| D222 | A traced number that turns out to be blocked is saved on the lead, shown as blocked, and cannot be called or texted, so it is never paid for again. | [02-teams-and-leads](02-teams-and-leads.md) |
| D223 | A lead's data is never shared between the agency's clients. A number traced or a note written for one client's lead is never used for another client's copy, and each client pays for its own. | [04-clients](04-clients.md) |
| D224 | Each agency sets how long a lead nobody works is kept (for example 2 years without contact). Before deletion the owner gets a list and can keep any lead with a reason. The lawyer sets the longest period allowed. | [02-teams-and-leads](02-teams-and-leads.md) |
| D225 | The owner's overview opens with what needs them today: waiting hand-ons, seat requests, blocked invitations, budgets running low, numbers losing health, overdue callbacks across teams. Numbers and charts come below. | [02-teams-and-leads](02-teams-and-leads.md) |
| D226 | A team lead's overview opens with their team right now: who is available, on a call or on a break; unanswered lead texts; overdue callbacks; unassigned leads. Today's results come below. | [02-teams-and-leads](02-teams-and-leads.md) |
| D227 | The owner, admins and team leads can schedule a weekly or monthly report to themselves or to a client's people inside Caller Whale. The email holds totals only; the details open in Caller Whale. | [02-teams-and-leads](02-teams-and-leads.md) |
| D228 | Reports use the agency's time zone, so everyone sees the same numbers. A team with its own hours still reports in the agency's zone. | [02-teams-and-leads](02-teams-and-leads.md) |
| D229 | Whoever holds a lead sees everything done on it for that client, by anyone, so they never repeat a call or contradict an earlier promise. | [02-teams-and-leads](02-teams-and-leads.md) |
| D230 | The owner and admins define lead fields per agency or client. Team leads create tags for their teams. Agents fill fields and apply existing tags but create neither. | [02-teams-and-leads](02-teams-and-leads.md) |
| D231 | Two copies of the same person for the same client can be merged by a team lead, admin or owner. History, threads and numbers are combined, and the merge can be undone for 7 days. | [02-teams-and-leads](02-teams-and-leads.md) |
| D232 | Agents and team leads can archive a lead (reversible). Only the owner and admins delete permanently, with a confirmation. A person's request to be erased is handled by the owner. | [02-teams-and-leads](02-teams-and-leads.md) |
| D233 | The owner or an admin can create a key for one outside tool, limited to what it needs (for example "add leads to Team A for Client X"). Every key can be switched off, its use is recorded, and no key can spend money. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D234 | The owner can choose events (a lead booked, a deal closed) to send to an address of theirs. Each message carries only the event and an ID; details are fetched with a key, so nothing personal travels unasked. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D235 | A public status page shows each part (sign-in, calls, texts, chats). When something is down, everyone signed in sees a short banner, and owners can choose to get an email. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D236 | After a security breach affecting an agency's data, its owner is told within 72 hours of Caller Whale knowing, with what happened and what to do. Telling leads or authorities follows the law, which the lawyer sets out. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D237 | A person can link Google, Microsoft or Apple to their account and sign in with it. The authenticator rules for owners, admins and team leads still apply. | [01-people-and-invitations](01-people-and-invitations.md) |
| D238 | The owner can require an authenticator for everyone in the agency. A member without one sets it up at their next sign-in before they can work. | [01-people-and-invitations](01-people-and-invitations.md) |
| D239 | Resetting a forgotten password needs the email link and either the authenticator or a saved recovery code. Someone who has lost both is checked by support, with a waiting period. | [01-people-and-invitations](01-people-and-invitations.md) |
| D240 | Each person sees their signed-in devices and can sign any of them out. The owner and admins can sign out every session of a member of their agency. | [01-people-and-invitations](01-people-and-invitations.md) |
| D241 | A Google, Microsoft or Apple sign-in can be linked to an existing account only while signed in to it, after confirming the provider's email. Invitations still match the account's main email. Apple's hidden relay addresses are accepted this way. | [01-people-and-invitations](01-people-and-invitations.md) |
| D242 | A sign-in from a new device sends an email and an account notification with the device and rough place, with a "This wasn't me" button that signs it out and starts a password reset. | [01-people-and-invitations](01-people-and-invitations.md) |
| D243 | The owner can limit their agency's members to sign in only from chosen countries, and only from chosen networks (office internet addresses). | [01-people-and-invitations](01-people-and-invitations.md) |
| D244 | Each agency sets how long a person can stay idle before being signed out, 8 hours by default. A call in progress never times out. | [01-people-and-invitations](01-people-and-invitations.md) |
| D245 | A partner is another business working on the same deals as the agency, for example a lender, a title company or another agent who helps close a client's deals. Partners see only what is shared with them on specific leads, and are free seats. | [04-clients](04-clients.md) |
| D246 | A client who hired two agencies has one sign-in and a switcher, like anyone in several agencies. Each agency sees only its own work for them, and neither knows about the other. | [04-clients](04-clients.md) |
| D247 | The owner can create a website form (a link or an embed) for a client. Each submission becomes a lead for that client in a chosen team, is checked against the block lists, and records the person's consent. | [04-clients](04-clients.md) |
| D248 | An agency can send a lead to another agency. Only the owner or an admin sends it, finding the other agency by its owner's Name#id, and only the receiving owner or an admin accepts it, into a team and client of theirs. | [02-teams-and-leads](02-teams-and-leads.md) |
| D249 | A sent lead carries its contact details and a note from the sender. Calls, recordings, texts and internal notes stay with the sending agency, and its client's data never leaves. | [02-teams-and-leads](02-teams-and-leads.md) |
| D250 | The sending agency keeps a closed copy marked "Sent to" the other agency. It is told only whether the lead was accepted and, if both agree, when the deal closes. It cannot see the receiver's work. | [02-teams-and-leads](02-teams-and-leads.md) |
| D251 | Every block on a sent lead's numbers goes with it, and the receiving agency cannot lift a block that came from the sender. Caller Whale's own database applies anyway. | [02-teams-and-leads](02-teams-and-leads.md) |
| D252 | The receiving agency can decline a sent lead with an optional reason. The sender is told and its copy reopens as a normal lead. | [02-teams-and-leads](02-teams-and-leads.md) |
| D253 | The two owners can note an agreed referral fee on a sent lead. Caller Whale shows it to both and reminds them when the deal closes. The money changes hands outside Caller Whale. | [02-teams-and-leads](02-teams-and-leads.md) |
| D254 | Before sending a lead to another agency, the sender must confirm the person agreed to be passed on. The confirmation is recorded with the date. The lawyer confirms the wording and when it is needed. | [02-teams-and-leads](02-teams-and-leads.md) |
| D255 | A partner sees the details and documents shared with them on a lead and can message the agency in that lead's partner thread. Partners never call or text the lead through Caller Whale. | [04-clients](04-clients.md) |
| D256 | Anyone holding a lead can attach files to it. Only team leads, admins and the owner can share a file with a client or partner. Every share is recorded and can be withdrawn. | [04-clients](04-clients.md) |
| D257 | Files on leads can be PDF, Word, Excel or common images, up to 25 MB each. Each file is scanned before anyone can open it, and storage counts against the agency's plan. | [04-clients](04-clients.md) |
| D258 | A shared file shows who opened or downloaded it and when. A shared link stops working when withdrawn or after a set time. | [04-clients](04-clients.md) |
| D259 | Signing documents is not part of this plan. Signing happens in the tools agencies already use, and signed copies are uploaded back to the lead. | [04-clients](04-clients.md) |
| D260 | Tasks are given down the team tree: the owner and admins to anyone, team leads to their teams' people and deputies, agents only to themselves. | [02-teams-and-leads](02-teams-and-leads.md) |
| D261 | A task is visible to the person, whoever gave it, their team leads, the owner and admins. A task on a lead is also visible to whoever holds the lead next. | [02-teams-and-leads](02-teams-and-leads.md) |
| D262 | A person is reminded when a task is due. If it is still open a day later, whoever gave it is told. A task someone gave themselves only reminds them. | [02-teams-and-leads](02-teams-and-leads.md) |
| D263 | A task can repeat daily, weekly or monthly. Each time is its own task, so missing one does not hide the next. | [02-teams-and-leads](02-teams-and-leads.md) |
| D264 | Removing a person ends their access to that agency at once on every device. The records of exports and lead views show what they looked at recently. What they remember or wrote down is a matter for the agency's own contracts. | [02-teams-and-leads](02-teams-and-leads.md) |
| D265 | Agencies stay blind to each other. Caller Whale never compares one agency's leads or people with another's, even when a person moves from one to the other. | [02-teams-and-leads](02-teams-and-leads.md) |
| D266 | The owner can export the agency's leads, history, notes, tasks and files (and recordings, if kept) in common formats at any time and when closing. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D267 | The owner sees each member's last sign-in, days active this month and the seats in use, so unused seats can be freed. Nothing beyond what reports already count is tracked. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D268 | Each agency registers its own texting brand with the carriers (US 10DLC). The owner enters the business details during setup and Caller Whale submits the registration. An agency cannot text until it is approved, so one agency's behaviour cannot get the others blocked. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D269 | Staff see each agency's complaint and opt-out rates. Above a threshold the owner is warned, then sending is limited, then the agency is suspended until staff review. Each step is recorded and the owner can appeal. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D270 | A new agency can set up, import and invite freely, but calling and texting open only after its business details pass the registration check, with a quick staff look for the first agencies. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D271 | Only the platform owner and cofounder, with a second step, see across agencies: agency-level numbers such as complaint rates, spend and seats, never lead details. Narrower staff roles (support, billing, moderation) come when there is a team. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D272 | At opening, calling and texting are for the US only. Other countries follow one by one, each with its own rules checked by the lawyer. | [06-do-not-call](06-do-not-call.md) |
| D273 | Numbers outside supported countries are marked on import and cannot be called or texted until that country is supported. | [06-do-not-call](06-do-not-call.md) |
| D274 | Caller Whale checks the federal Do Not Call list for every agency, and state lists where a state keeps one. Each agency holds its own registry access, as the law requires per business, and Caller Whale uses it on their behalf. | [06-do-not-call](06-do-not-call.md) |
| D275 | Registry access is its own cost in each agency's plan, priced as a feature of its own. | [06-do-not-call](06-do-not-call.md) |
| D276 | The owner switches call recording on for the agency or for chosen teams. When it is on, Caller Whale plays or prompts the notice the lead's state requires (some states need everyone's consent). The lawyer confirms the wording. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D277 | An agent can pause and resume recording during a call. The recording shows where it was paused and for how long, and captions pause with it. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D278 | Team leads, admins and the owner record voicemail messages per client or team. An agent picks one on reaching a voicemail; it plays while the agent moves to the next call. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D279 | Agents dial one lead at a time; auto dial moves to the next after each outcome. Caller Whale does not dial several numbers at once, since abandoned calls are strictly limited by law. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D280 | A deal's money (offer, contract price, expected profit) is seen by the closer working it, the team's leads and deputies, admins and the owner. Callers see the deal's stage but not its figures. | [02-teams-and-leads](02-teams-and-leads.md) |
| D281 | Reports show a client their deal count and total value. A single deal's figures appear to them only if the agency shares that deal. | [04-clients](04-clients.md) |
| D282 | A property is its own record within a client's work, and the people linked to it (owner, tenant, heir) are leads. Notes about the property are shared by everyone working any of its leads for that client. | [02-teams-and-leads](02-teams-and-leads.md) |
| D283 | When a deal closes, its lead is marked "won" and leaves the calling queues. Follow-ups happen only through tasks someone creates. It still counts for credit, reports and any commission. | [02-teams-and-leads](02-teams-and-leads.md) |
| D284 | Every new screen meets WCAG AA: it works with a keyboard and a screen reader, keeps readable contrast, and allows larger text without breaking. This is checked as part of each step. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D285 | Captions and the AI's call suggestions work in English at opening, with Spanish next. The app's own screens stay in English (D171). | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D286 | Each lead shows its own local time and whether it is inside calling hours now. Tasks, appointments and everything else show in the viewer's own time zone. | [02-teams-and-leads](02-teams-and-leads.md) |
| D287 | With no connection, the open tab keeps what it has loaded and keeps typed notes and drafts in memory, and sends changes when the connection returns. Since nothing is saved in the browser (D194), closing the tab while offline loses unsent work, with a warning first. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D288 | Personal chats are free for every account. They belong to the person, so no agency pays for them; Caller Whale carries their cost. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D289 | Each of these is priced as its own feature: call recording and its storage, AI call suggestions and captions, number checks and reassigned-number checks, and files on leads beyond a free amount. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D290 | Client and partner people stay free seats, up to a generous number per client (10 to start), since they never call or text. Above that the owner asks Caller Whale. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D291 | Each step records what its feature costs Caller Whale to run. The sell price is set when the step is built and its real cost is known, in line with pricing each feature on its own. | [07-platform-and-rollout](07-platform-and-rollout.md) |
