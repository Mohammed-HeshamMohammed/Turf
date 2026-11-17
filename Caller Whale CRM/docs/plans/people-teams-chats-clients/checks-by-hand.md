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
