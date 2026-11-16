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

Assumed until the owner says otherwise:

| # | Assumption |
| --- | --- |
| A7 | Platform staff see a member's phone only through the person's own setting. |

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
- **Managers invite into their own teams (D15).** A manager can invite callers and closers into teams they run, counted against the agency's seats. The owner sees every invitation and can withdraw any. A manager cannot invite another manager, a client, or into a team they do not run. (Problem 4.)
- **Say why the panels are hidden.** The authenticator screen says that members and invitations open after it. (Problem 5.)
- **Name the agency.** The invitation card and the email show the agency's name and who invited. (Problem 16.)
- **Accept and arrive.** The email link opens that invitation. After accepting, the person is taken into the new agency, and the CRM opens it at the next sign-in. The CRM's "not invited" screen shows pending invitations and lets the person accept there. (Problems 6, 11, 17.)
- **Unverified email.** The Dashboard says "An invitation is waiting. Confirm your email to see it." (Problem 7.)
- **Wrong address.** The error says which address the invitation was sent to, masked. (Problem 8.)
- **Delivery state.** "Not set up" and "failed" are different messages. Resend and "extend by 72 hours" are added, both limited. (Problems 9, 10.)
- **Blocked, not broken.** An invitation whose team is gone or whose seat is taken shows as "Blocked" with the reason; the owner can pick another team or free a seat. A seat is held for a pending invitation, so acceptance does not fail on seats. (Problems 12, 13.)
- **Inviter removed (D7, D13).** When an inviter is removed, suspended or loses the right to invite, their pending invitations are cancelled at that moment and marked "Cancelled: inviter removed". The invited person sees "This invitation was cancelled." A restored inviter does not revive them. Acceptance still checks the inviter as a second guard. (Problem 14.)
- **One system.** Trace the old token path and remove it if nothing uses it. (Problem 15.)
- **Leaving.** A person can leave an agency themselves, except its owner. (Problem 19.)

### Part 2. One person, several agencies

- **Profile (D2, D3, A7).** Name, email and avatar are one profile in the auth service; agencies read it and cannot edit it. Per agency there is only role, team, limits and suspension.
- **Phone setting.** In Settings, next to authentication: "Who can see my phone number": nobody (the default), my agency's owner and managers, or everyone in my agencies. The server leaves the number out unless the setting allows it; hiding it on screen is not enough.
- **Each agency sees only itself.** No agency is told about a person's other agencies.

### Part 3. Display name tag (D5, D14)

- A person's full name is `Alex Morgan#K7P2`. Everywhere in the app shows "Alex Morgan". The tag appears only to tell two people apart in a list, and in the person's own settings.
- The name and tag together are unique. Look-alike letters count as the same letter, and `#` is not allowed in a name.
- Existing people get a tag automatically; no name changes. The existing `username` (the address of a profile page, `0019_username.sql`) stays as it is.
- **Search.** Part of a name finds only people in your own agencies. A full `Name#id` finds exactly one person anywhere, with rate limits, so nobody can list every user.
- **Settings**, next to the phone setting: "Who can find me" and "Who can message me".

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
- **Agent leaves (D20).** Their threads go to the team's manager, or to the owner when the team has none. This runs in the same step that removes them from the agency's conversations (roster sync).
- **Unanswered texts (D21).** A reply from a lead waits with the agent as unread. After the agency's wait time (set in the agency's settings, 15 minutes by default, counted in working hours) the manager is notified and can take over.

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
| 10 | Lead threads: access by lead, one sender, takeover, reassignment, agent leaving, the unanswered-text wait | the SMS stage |

Each step ships on its own, with its tests, and is checked in the web app before the next starts.

## Open questions

1. Confirm A7 (staff and phone numbers).
2. Should an agency be able to switch personal chats off for its own screen while people are working? Not planned.
3. Who on staff reads reports? (The 90 days is decided; the lawyer may change it.)
4. Suggested and turned down by the owner, recorded so it is not raised again: requiring a person to select an "active team" before opening a lead thread.

## Not verified

- The exact words on the Members screen for creating a team.
- The sign-up path for an invited person with no account yet.
- The platform-staff invitation flow.
- Whether the old token invitation path is still used.
- Whether a removed agency's offline copy is deleted today.
- How the Dashboard's workspace picker behaves with several agencies.
- How the core service decides which team may see a lead (needed for Part 6).
