# People and invitations

**State:** plan only, nothing built. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

Who can be invited, how an invitation works from sending to arriving, one person in several agencies, the profile, the name tag, and the settings each person controls.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D1 | One person can belong to several agencies. This is a supported case. | - |
| D2 | A person's name, email and other profile details are one profile, shared with every agency they are in. | - |
| D3 | A personal phone number is shown only if the person chooses to: a setting next to authentication. | - |
| D5 | Display names get a `#id` tag so two people never look the same in a search. Everyone normally sees the name without the tag. | - |
| D7 | When the person who sent an invitation is removed, the invitation is cancelled and gives no access. | - |
| D13 | Removing an inviter cancels pending invitations only. People who already accepted keep their access. | - |
| D14 | The tag is generated automatically and the person can change it. | - |
| D15 | A team manager can invite callers and closers into the teams they run. The owner sees every invitation and can withdraw any. *Researchers too: D369.* | - |
| D22 | Platform staff see a member's phone only through the person's own setting. | - |
| D25 | A person can leave an agency at once. Their leads, tasks and threads go to their managers (or the owner), and the owner can then decide where it goes: all of it to one person, or parts to different people. The same choice applies when someone is removed. | - |
| D26 | A suspended person's leads and threads are held by their managers, who can read and take over. On restore everything not reassigned returns to the person. | - |
| D27 | If an owner's account is closed or disabled, the agency is paused (members read, nobody works) and Caller Whale staff hand it on or close it. | - |
| D28 | An active owner can hand the agency to a member. Both confirm with a second step; the old owner becomes a manager or leaves. *Replaced by D200 where they differ: the old owner may also become an admin.* | - |
| D29 | Name and tag changes are limited (for example twice in 30 days). An old `Name#id` is reserved for 90 days so nobody can pose as its last holder. | - |
| D30 | New accounts start with: people in my agencies find me by name; anyone else needs my exact `Name#id` and sends a request. | - |
| D41 | Each agency sets how long its invitations stay valid. | - |
| D47 | An invitation link lets a new person sign up inside it: email filled in and locked, opening the link confirms the email, and they land in the agency. *How it works with the CRM: D368.* | - |
| D56 | A removed person can be invited back and starts fresh: nothing assigned, old chats only where they are added again. The owner sees they were a member before. | - |
| D57 | A reason for a removal or suspension is optional. If one is written, the person sees it. | - |
| D58 | The record of people changes: the owner sees all of it, managers see their teams', each person sees changes made to themselves. | - |
| D68 | The invited person can decline. The sender sees "Declined" and the seat is freed at once. | 2 |
| D69 | One person can own several agencies, each with its own plan, seats, teams and data. | 13 |
| D71 | A manager inviting with no free seat is blocked and can send the owner a request to add one. Nothing is charged without the owner. | 3 |
| D91 | A "My access" page lists every agency the person belongs to with role and teams, pending invitations, signed-in devices, and a Leave button per agency. | 15 |
| D92 | Every invitation shows the agency's name, when it was created, and the owner's full `Name#id`, with a "Report this invitation" button that goes to staff. New agencies need no approval. | 1 |
| D93 | Pending invitations cannot exceed the agency's free seats, and there is a daily cap. A person can block an agency so it can never invite them again, and report it. | 2 |
| D95 | Managers and deputies must have an authenticator set up, like owners. They are asked for a code at sign-in, not at every action. | 11 |
| D99 | A person can download their profile, settings and personal chats. Agency data belongs to the agency and is exported by its owner. | 15, 9 (lawyer) |
| D106 | Existing people learn about their tag from a one-time note in settings. No email. | 4 |
| D174 | A cancelled or withdrawn invitation sends no email. The invited person sees "This invitation was cancelled" if they open the link or their dashboard. | 2 |
| D175 | An invitation can be resent at most once an hour and three times in total, and extended twice. After that the owner withdraws it and sends a new one. | 2 |
| D176 | An agency can never have more pending invitations than free seats, and no more than 50 new ones in a day. Staff can raise the daily number for a large agency. | 2 |
| D177 | Someone signed in with a different address than the one invited is shown the first letter and the domain of the invited address, for example m•••••@gmail.com. | 1 |
| D186 | A tag is 4 letters and digits, for example #K7P2. Characters that are easily confused (0 and O, 1 and I) are never used. A person changing theirs picks 3 to 8 characters from the same set. | 4 |
| D187 | The tag appears beside a name only when the same name occurs twice in what is on screen. Otherwise names stay clean. | 4 |
| D237 | A person can link Google, Microsoft or Apple to their account and sign in with it. The authenticator rules for owners, admins and team leads still apply. | 35 |
| D238 | The owner can require an authenticator for everyone in the agency. A member without one sets it up at their next sign-in before they can work. | 35 |
| D239 | Resetting a forgotten password needs the email link and either the authenticator or a saved recovery code. Someone who has lost both is checked by support, with a waiting period. | 35 |
| D240 | Each person sees their signed-in devices and can sign any of them out. The owner and admins can sign out every session of a member of their agency. | 35 |
| D241 | A Google, Microsoft or Apple sign-in can be linked to an existing account only while signed in to it, after confirming the provider's email. Invitations still match the account's main email. Apple's hidden relay addresses are accepted this way. | 35 |
| D242 | A sign-in from a new device sends an email and an account notification with the device and rough place, with a "This wasn't me" button that signs it out and starts a password reset. | 35 |
| D243 | The owner can limit their agency's members to sign in only from chosen countries, and only from chosen networks (office internet addresses). | 35 |
| D244 | Each agency sets how long a person can stay idle before being signed out, 8 hours by default. A call in progress never times out. | 35 |
| D336 | The old token invitation path (`#/join?token=`, `/api/v1/invitations/join`) has no server handler left. Its CRM code, test and contract line are removed in step 3, leaving one invitation system. (Problem 15.) | 3 |

## Notes

- D15: a manager cannot invite another manager or into a team they do not run. Inviting clients follows D94 (see the clients file).

## Invitations

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

## One person, several agencies

- **Profile (D2, D3, D22).** Name, email and avatar are one profile in the auth service; agencies read it and cannot edit it. Per agency there is only role, team, limits and suspension.
- **Phone setting.** In Settings, next to authentication: "Who can see my phone number": nobody (the default), my agency's owner and managers, or everyone in my agencies. The server leaves the number out unless the setting allows it; hiding it on screen is not enough.
- **Each agency sees only itself.** No agency is told about a person's other agencies.
- **Suspension (D26).** A suspended person keeps their place. Their leads and threads are held by their managers, who can read and take over. On restore, whatever was not reassigned returns.
- **Owner gone (D27).** If the owner's account is closed or disabled, the agency is paused: members can read, nobody can work, invitations stop. Caller Whale staff hand it to another person or close it.
- **Handing over ownership (D28).** An active owner picks a member; both confirm with a second step. The old owner becomes a manager or leaves. Until both confirm, nothing changes.
- **Shared devices (D38).** At sign-in: "This is my device" remembers the sign-in; "Shared device" signs out when the tab closes. No lead data is saved in the browser either way.
- **Seats (D46).** A seat is one person in one agency.

## Display name tag

- A person's full name is `Alex Morgan#K7P2`. Everywhere in the app shows "Alex Morgan". The tag appears only to tell two people apart in a list, and in the person's own settings.
- The name and tag together are unique. Look-alike letters count as the same letter, and `#` is not allowed in a name.
- Existing people get a tag automatically; no name changes. The existing `username` (the address of a profile page, `0019_username.sql`) stays as it is.
- **Search.** Part of a name finds only people in your own agencies. A full `Name#id` finds exactly one person anywhere, with rate limits, so nobody can list every user.
- **Settings**, next to the phone setting: "Who can find me" and "Who can message me". A new account starts with: my agencies by name, anyone else by exact `Name#id` and a request (D30).
- **Changes (D29).** The name and the tag can each be changed a limited number of times (twice in 30 days to start). The previous `Name#id` cannot be taken by anyone else for 90 days.

## Note on sign-in limits (D243, D244)

A person can belong to several agencies (D1) but signs in once. When agencies set different country, network or idle limits, each agency's limit applies while the person works inside that agency: the person stays signed in, and an agency whose limit is not met is closed to them until it is (for example, outside the allowed network). The strictest idle time applies only to the agency that set it.

## Note on where these screens live (D328, D329)

Everything in this file about managing people (the invite form, team screens, member lists, the hand-on screen) is built in the CRM, not on the website Dashboard. Today those panels are in `apps/website/src/AccessManagement.tsx`; step 3 and step 11 move them. The Dashboard keeps the person's own account, sign-up, plans and billing, and still lists pending invitations.
