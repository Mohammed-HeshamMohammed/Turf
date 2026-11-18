# Checks to try by hand

Steps built so far, as they look on the live site. Automated tests cover the server side. Steps 1 and 2 (invitations) come first, then step 11 (teams and roles).

# Invitation steps 1 and 2

Built and deployed on 2026-11-17.

**Built around what you can do today:**
- Each check uses a **new throwaway address**, so nothing needs withdrawing.
- Each check invites as **Team manager** or **Client / partner**, which need no team. Callers and closers need a team until invitations can carry teams (build step 3).

Your agency's invitations are on the Dashboard under **Overview → Usage → Invite workspace members**. "Invited person" means the throwaway account, signed in on its own: another browser profile or a private window.

## As the agency (your account)

| # | Do | Expect |
|---|---|---|
| A1 | Open the invite panel | "Invitations last **7 days**". The choice can be changed and stays after a reload. |
| A2 | Change it to 3 days, invite a new address | That invitation ends 3 days from now. Set it back to 7 afterwards. |
| A3 | Invite a new address | "Invitation emailed." The row says **Waiting**, **Emailed**, with Resend, Extend and Withdraw. |
| A4 | Hover Resend right after sending | Greyed out: "Can be resent after …" (one hour after sending). |
| A5 | After an hour, press Resend | "Invitation emailed again." It works three times in all; after that the button is gone. |
| A6 | Press Extend | "Extended until …", a full validity from now. It works twice in all; after that the button is gone. |
| A7 | Invite the same address twice | "An invitation is already pending for this email." |
| A8 | Invite an address that blocked your agency (see B6) | "This person has chosen not to receive invitations from this agency." |
| A9 | Look at the list a day after an invitation was declined (see B5) | It still shows, as **Declined**, for a week. |

## As the invited person (throwaway account)

| # | Do | Expect |
|---|---|---|
| B1 | Open the invitation email | Subject "Join *your agency* on Caller Whale" and a button "Open the invitation". The agency's name appears once you have opened the CRM since the deploy; before that it reads "Mohammed Hesham's workspace". |
| B2 | Press the button while signed out | Sign-in page; after signing in, the Dashboard opens with this invitation. |
| B3 | Sign up with that address but do not confirm the email yet | "An invitation is waiting. Confirm your email to see it." and nothing else. |
| B4 | After confirming, look at "Your invitations" | Agency name, "owner Mohammed Hesham", the role, when it was sent and when it ends, with Accept, Decline, Block this agency and Report this invitation. |
| B5 | Decline one invitation | It disappears. Opening its email link again says "You declined this invitation." The agency sees Declined (A9). |
| B6 | On another invitation, Block this agency | It disappears and the agency can no longer invite this address (A8). |
| B7 | Report this invitation, with or without a reason | "Thank you. Caller Whale staff will look at this invitation." The invitation stays. |
| B8 | Open an invitation's link while signed in as a **different** account | "This invitation was sent to c•••••@nbasweeps.com. Sign in with that address to accept it." |
| B9 | Accept an invitation | You land on the Dashboard as a member of the agency. Opening its link again says "You already accepted this invitation." |

## Not checkable by hand yet

- **Blocked, Cancelled, the daily limit:**
  - "Blocked" needs a team deleted, or seats lowered, after sending.
  - "Cancelled: inviter removed" needs a team lead who sent invitations, which comes with step 3.
  - The 50-a-day limit would take 50 invitations.
  - Automated tests cover all three.
- **Unblocking an agency:** the server supports it, but there is no button yet. It comes with the CRM's people screens (D332).
- **Reported invitations:** staff can list them through the server, but there is no staff screen yet.

# Step 11: teams and roles

All of this sits behind the **new team rules** switch, off until you turn it on. It's on the same panel as your agency's teams (Overview → Usage → Teams and members). As platform staff you see "New team rules for this agency (staff only): off · Turn on". Turning it off takes the new abilities away at once; what was saved stays.

## Before turning it on

| # | Do | Expect |
|---|---|---|
| T1 | Create a team with "Team lead: Choose later" | It's created with no lead. This works now without a fresh two-step code, because inside your own agency you're its owner, not staff. |
| T2 | Look at the role choices for an invitation | Team lead, Caller, Acquisitions / closer, Client / partner. **No** Admin or Data researcher yet. |
| T3 | Read the panel | "Team lead" everywhere it used to say "Team manager". |

## After turning it on

| # | Do | Expect |
|---|---|---|
| T4 | Press "Turn on" | "The new team rules are on for this agency." The Teams table gains **Team leads** (pick several with Ctrl-click) and **Deputy leads**. |
| T5 | Invite someone as **Admin**, and someone as **Data researcher** into a team | Both roles now appear in the role list. The researcher needs a team, like a caller. |
| T6 | Give a team two leads (once you have two Team leads) | Both show; either can manage that team's callers. Neither can suspend the other. |
| T7 | Change a caller's teams to two or three teams | Saved; the Members list shows every team. More than five is refused. |
| T8 | Give a person two roles (for example Team lead and Closer) | Saved; both roles show. |
| T9 | Name a deputy lead for a team | Saved. In the CRM, the deputy sees that team's leads, but not the leads of colleagues in their own team. |
| T10 | Try to name a fourth admin | "This agency has 3 admins, its limit. Ask Caller Whale to raise it." |
| T11 | As an admin (second account), try to change another admin | "Only the agency owner changes an admin." |
| T12 | Remove a team lead who leads a team | Allowed now. The team keeps its other leads, or has none. |
| T13 | Press "Turn off" | Two leads on one team, deputies, admins and several teams can no longer be saved. Teams keep what they had. |

## Not in this step

- **Authenticator:** team leads and deputies aren't asked to set up an authenticator yet (D95). That comes with the sign-in work (step 35).
- **Team switch:** the CRM's team switch and "All my teams" view come with the CRM's people screens.
- **Researcher seat price:** a researcher still takes a normal seat. The cheaper researcher seat comes with billing (step 22).

# Step 3: invitations that carry teams, team leads inviting, leaving

| # | Do | Expect |
|---|---|---|
| S1 | Create a team with no lead, then invite a new address as **Team lead** and pick that team under "Teams they will lead" | Sent. When the person accepts, the Teams table shows them as that team's lead, with nothing more to do. |
| S2 | Under the old rules, pick a team that already has a lead | "… already has a team lead. A team gets several leads under the new team rules." |
| S3 | With the new team rules on, sign in as a team lead (second account) and open **Invitations** | The panel is there. They can invite a caller, closer or researcher into a team they lead, and see only the invitations they sent. |
| S4 | As that lead, try a team they don't lead, or the Team lead role | Refused, with the reason. |
| S5 | As that lead, invite when every seat is taken | "Every seat is taken. Your agency owner has been asked to add one; nothing is charged until they do." On your account, the Invitations panel lists the request with a **Done** button. |
| S6 | Take that lead off their team | Their waiting invitations into that team show **Cancelled: The person who sent it can no longer invite.** |
| S7 | As a member (not the owner), press **Leave** next to the agency under Memberships | Asked to confirm; then the agency is gone from their dashboard. Their waiting invitations are cancelled. Your account has no Leave button for your own agency. |

Not in this step:
- **CRM screens:** the people and invitation screens in the CRM come later.
- **Handing on work:** the screen for handing on the work of someone who left is step 12.
- **Clients:** team leads inviting clients comes with the clients step.

# Step 20, part A: leads and teams (server only)

Team settings, the unassigned pool and claiming have no screen yet; they come with the CRM's people screens, and automated tests cover them. You can check these in the CRM as it is:

| # | Do | Expect |
|---|---|---|
| L1 | As a team lead, assign a lead of your team to a team you don't lead | "A team lead moves leads only between teams they lead". As the owner it works. |
| L2 | As a caller, hand off a lead to a closer in another team | "Hand off to someone in this lead's team. Sending it to another team is a move a team lead makes". The same closer in your own team works. |
| L3 | As a team lead, delete a lead | "Only the agency owner or an admin deletes a lead for good. Archive it instead". Archive still works; the owner can still delete. |

# Step 20, part B: whole-team view and imports into a team (server only)

The whole-team view setting, the "already exists in another team" decision and removing a list have no CRM screen yet; automated tests cover them. Once they have screens:

| # | Do | Expect |
|---|---|---|
| L4 | As a team lead, turn on "agents see the whole team" | The team's callers see each other's leads, marked read-only; they can open them but not change them, add notes or see deal figures. Another team sees nothing new. |
| L5 | Import a list into a team | Its new leads land unassigned in that team, for its leads to hand out. |
| L6 | Import a list containing someone another team already holds | That row waits; the importer sees "These leads already exist in another team" with a count only. You choose: they keep it, both keep a copy, or move it here. |
| L7 | Remove a list you imported less than 24 hours ago, before anyone worked it | Its new leads are gone. After a call, note, deal or edit on any of them, it is refused. |

# Step 20, part C: tags, merging, retention (server only)

No CRM screens yet; automated tests cover them. Once they have screens:

| # | Do | Expect |
|---|---|---|
| L8 | As the owner, make an agency tag; as a team lead, make a team tag; as a caller, try to make one | The first two work; the caller can only apply existing tags. A team's tag can't go on another team's lead. |
| L9 | As a team lead, merge two copies of the same person in your team | One lead remains with both histories, every number and email; the other disappears. Undo within 7 days brings it all back; after 7 days undo is refused. A caller can't merge. |
| L10 | As the owner, set "keep unworked leads 30 days" | The list of leads due appears. Keeping one with a reason takes it off the list. Only the owner removes what is due; nothing goes on its own. |

# Step 12: handing on work (server only)

No screen yet; automated tests cover it. Once it has one:

| # | Do | Expect |
|---|---|---|
| H1 | Remove a caller who holds leads | Their leads stay in their team; the team's lead can open and work them. "Hand on" lists the person with how many leads and tasks. |
| H2 | As the team's lead, hand their leads to another caller | The leads and their open callbacks move, due times kept; notes stay on the leads. Another team's part stays for that team's lead or you. |
| H3 | Hand the rest back to the team | Those leads become the team's unassigned leads. |
| H4 | Suspend a caller, then restore them without handing anything on | All their leads are still theirs. |

# Step 16, part A: directory, record of people changes, edit window, search

| # | Do | Expect |
|---|---|---|
| D1 | As a caller (second account), open the CRM's team list or directory | Everyone in the agency with role and team. Emails show only for themselves, not for others. As the owner, every email shows. |
| D2 | Edit a chat message right away, then after 15 minutes | The first edit works; the second says "A message can be edited for 15 minutes after it was sent." Deleting still works. |
| D3 | Suspend a caller with a reason, then ask for the record of people changes (no screen yet: `GET /v1/orgs/{org}/people-log`) | The owner sees everything; the team's lead sees their team's changes; the caller sees only what was done to them, with the reason. |
| D4 | Search messages (no screen yet: `GET .../messages/search?q=`) | Only messages in conversations the person is in, in this agency. |

# Step 16, part B: team chats, announcements, mentions (server only)

The CRM's Inbox still shows sample conversations, so these wait for its chat screen. Automated tests cover them.

| # | Do | Expect |
|---|---|---|
| C1 | Put a caller in a team, then open chats as them | A chat named after the team, with its lead, deputies and members, and the Announcements channel. You, the owner, are not in a team chat you do not lead. |
| C2 | As the caller, try to leave the team chat, then mute it | Leaving is refused ("Everyone in a team is in its chat while they are in the team"); muting works. |
| C3 | Move the caller to another team; rename the first team | They leave the first team's chat and join the second's, with only new messages unread. The first chat takes the new name. |
| C4 | As the caller, post in Announcements; as the team lead, post one marked important with @everyone | The caller is refused and can still react; the lead's post shows as important and mentions everyone. |
| C5 | In a team chat write @team and @managers; in a direct chat write @team | The team's people, then its leads and deputies, are mentioned; in a direct chat @team needs a team named. |

# Step 4: name tags and privacy

On callerwhale.com, Settings → Privacy. Use a throwaway account where a second person is needed.

| # | Do | Expect |
|---|---|---|
| N1 | Open Settings → Privacy | A note "You have a tag" with your full name, e.g. Your Name#K7P2; "Got it" hides it for good. |
| N2 | Change your tag to something with an O or a 1 | Refused: those characters are left out. A tag like WHALE saves. |
| N3 | Change your tag a third time the same month | Refused: twice in 30 days, with how many days to wait. |
| N4 | Set "Who can see my phone number" to Nobody, then to owners, admins and team leads | Saved each time. In the agency's member list, a member's phone shows only when their own setting allows it. |
| N5 | Send an invitation and open it as the invited person | The owner is named in full, with the tag. |

# Step 15: sign-up inside an invitation, devices, My access

| # | Do | Expect |
|---|---|---|
| P1 | Invite a throwaway address that has no account; open the email's link in a private window | The sign-up page, with the address filled in and locked and who invited you. After creating the account, no confirmation email is needed and the invitation is there to accept. |
| P2 | Open the same email link again | "This invitation link has ended or was already used." |
| P3 | Sign in choosing "Shared device", then close the tab and open callerwhale.com again | You are signed out. With "This is my device", you stay signed in. |
| P4 | Settings → My access | Your agency by name with your role (and teams if any), waiting invitations, your signed-in devices with "Sign out", and "Download my data", which saves a file. |
| P5 | As the throwaway member, Settings → My access → Leave | You leave at once; the agency's member list no longer shows you. |

# Step 5: the web cache (app.callerwhale.com)

| # | Do | Expect |
|---|---|---|
| W1 | Open the CRM in two tabs; change a lead in one | The other shows the change within a minute (at once when live updates are on), without losing its place in the list. |
| W2 | Start typing a note, and meanwhile have someone import a large list | Your note and the screen stay as they are; the records load again only after you stop typing. |
| W3 | Turn the network off, change a lead, then try to close the tab | The browser asks before closing. Turn the network back on instead: the change is sent. |
| W4 | With two agencies: change something while offline, switch agency, then switch back online and return | The change waited and is sent when you are back in that agency. |
| W5 | Remove the throwaway member while they have the CRM open | Within a minute their screen leaves your agency and says they no longer have access. |
| W6 | Sync page → Reload everything | The records load again from the start; the line under the title says when they were last up to date. |

# Step 13: handing over an agency

Needs two-step sign-in on both accounts. Do it with a throwaway agency, not your real one.

| # | Do | Expect |
|---|---|---|
| O1 | As a throwaway agency's owner, Dashboard → Hand over this agency: pick a member, "You become: An admin", Offer | "Offered. They have 7 days to accept." and the offer shows with Cancel. |
| O2 | As that member, Dashboard → Agencies offered to you → Accept | "You now own …". The old owner is now an admin. Without two-step sign-in it asks for it first. |
| O3 | Offer again and Cancel | "Cancelled. Nothing changed." The member no longer sees it. |
| O4 | As staff, staff area → Access → Pause and hand on: pause the throwaway agency | Its members can open it but cannot call, import or invite. "End the pause" undoes it. |
| O5 | As an admin of the paused agency, Memberships → Owner unreachable? | "Asked." Staff see the request, and Approve is refused until the agency has been paused for 14 days. |

# Step 17: solo to agency

| # | Do | Expect |
|---|---|---|
| U1 | With a throwaway solo workspace that has a few leads, CRM → Team → Make this an agency | "Your workspace is now an agency. N leads are in <your name>'s team." After the reload you are the agency owner, and the leads keep their history. |
| U2 | Look at the Team page again | The button is gone; inviting callers works as in any agency. |
