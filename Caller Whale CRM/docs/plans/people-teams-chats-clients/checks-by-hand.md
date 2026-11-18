# Checks to try by hand

Steps built so far, as they look on the live site. Automated tests cover the server side. Steps 1 and 2 (invitations) come first, then step 11 (teams and roles).

# Settings and setup to do first

Everything below is yours to do: secrets are set in Coolify only, never in chat or in a file. A step whose settings are empty stays off
and the rest keeps working. Each service's `env/<service>.production.example` explains every setting. Tick a row once it is done.

## Tokens between services

Each token is a random value of 32 characters or more (`openssl rand -hex 32`). The same value goes on both sides.

| # | Set | On | Matching value on | Turns on |
|---|---|---|---|---|
| T1 | `DIALER_TOKEN` | crm-core | dialer-sms `CRM_TOKEN` (and `CRM_URL=http://crm-core:8107`) | The dialer asking the CRM about leads and logging calls (steps 10, 21, 25) |
| T2 | `AUTHZ_TOKEN` | dialer-sms | authz `AUTHZ_TOKENS`: add `,dialer-sms=<token>` | The dialer checking people's rights |
| T3 | `BILLING_TOKEN` (and `BILLING_URL=http://billing:8103`) | dialer-sms | billing `BILLING_TOKENS`: add `,dialer-sms=<token>` | Budgets for calls and texts (step 22) |
| T4 | `BILLING_TOKEN` (and `BILLING_URL=http://billing:8103`) | crm-core | billing `BILLING_TOKENS`: add `,crm-core=<token>` | Charging the in-app assistant, with the daily cap (step 26), and reading the plan's file storage (step 38) |
| T5 | `AGENT_TOKEN` | assistant | crm-core and dialer-sms `ASSISTANT_TOKEN` (and `ASSISTANT_URL=http://assistant:8109`) | The in-app assistant and call summaries (step 26); needs `OPENROUTER_API_KEY` on the assistant |
| T6 | `NOTIFY_MAIL_TOKEN` (and `NOTIFY_MAIL_URL=http://notifications:8102`) | crm-core | notifications `NOTIFY_TOKENS`: add `,crm-core=<token>` | Scheduled report emails (step 32) |
| T7 | `AUTH_MCP_TOKEN` | auth | mcp `MCP_AUTH_TOKEN` | Outside AIs asking for changes that wait for you (step 24) |

## Per container in Coolify

What each container needs added or changed for steps 10 to 34, by the names in your Coolify project. Private addresses use each
container's network alias (`http://<alias>:<port>`), as the existing settings do. Every setting's meaning is in
`env/container-notes.json`; `node tools/env-notes.mjs render <name>` prints a container's list (names and notes, never values), and
`node tools/env-notes.mjs check` confirms the examples and notes agree.

**Not yet compared with the live containers:** Coolify could not be opened from here (Cloudflare's check stopped the built-in browser and
Chrome was not connected). The rows marked **verify** are what the code expects; check them against Coolify.

| Container | Add or change | Then |
|---|---|---|
| Caller Whale Gateway | Redeploy for steps 40 and 42's auth routes (help, support, feedback, browser errors). `AUTHZ_URL=http://authz:8104` and `AUTHZ_TOKEN` (the `gateway=` value in authz's `AUTHZ_TOKENS`) for agencies' place limits (step 35); **verify** `ROUTES` sends `gate.callerwhale.com` (its `CORE_HOST`) to `http://crm-core:8107`. The example still shows `http://notifications:8102` there; the CRM's routes (sync, imports, Google's return, email links and unsubscribe, tool keys) need crm-core | Redeploy (new open routes for steps 28, 29, 33 and auth's step 34 routes) |
| Caller Whale Live Server | nothing new | — |
| Caller Whale AI Assistant | `AGENT_TOKEN` (T5); `OPENROUTER_API_KEY` (S3) | Redeploy |
| Caller Whale Authentication | `STATUS_PROBES` (optional), like `sign_in=http://auth:8101/healthz,crm=http://crm-core:8107/healthz,calls=http://dialer-sms:8113/healthz,chats=http://messaging:8108/healthz`; `AUTH_MCP_TOKEN` (T7) if not set | Redeploy (new tables for the status page and breach notices) |
| Caller Whale Authorization | `AUTHZ_TOKENS`: add `gateway=<token>` (step 35) and `dialer-sms=<token>` (T2), and `messaging=<token>` if it is not there; optional `AUTHZ_FEATURES_EVERYWHERE=teams_v2` (P-1) | Redeploy |
| Caller Whale Billing | `BILLING_TOKENS`: add `dialer-sms=<token>` (T3) and `crm-core=<token>` (T4) | Redeploy (the `ai` use kind) |
| Caller Whale CRM Core | `CLAMD_ADDR=clamav:3310` (step 38, after ClamAV runs); `DIALER_TOKEN` (T1); `ASSISTANT_URL=http://assistant:8109`, `ASSISTANT_TOKEN` (T5); `BILLING_URL=http://billing:8103`, `BILLING_TOKEN` (T4); `NOTIFY_MAIL_URL=http://notifications:8102`, `NOTIFY_MAIL_TOKEN` (T6); `APP_URL=https://app.callerwhale.com` (**verify** the CRM web app's address); `GOOGLE_*` (S4, `GOOGLE_REDIRECT_URL=https://gate.callerwhale.com/api/v1/google/callback`); `EMAIL_*` and `AWS_*` (S5, `EMAIL_PUBLIC_URL=https://gate.callerwhale.com`) | Redeploy (migrations 0032 to 0041 run on start) |
| Caller Whale Dialer | `CARRIER_CHECK=on` (the default) and, live, `TELNYX_WEBHOOK_URL` for the 10DLC updates (step 39). Deploy it first (S1): `CRM_URL=http://crm-core:8107`, `CRM_TOKEN` (T1); `AUTHZ_URL=http://authz:8104`, `AUTHZ_TOKEN` (T2); `BILLING_URL=http://billing:8103`, `BILLING_TOKEN` (T3); `ASSISTANT_URL=http://assistant:8109`, `ASSISTANT_TOKEN` (T5); `TELNYX_*` (S2) | Simulator first, then live |
| Caller Whale Importing Worker | nothing new | — |
| Caller Whale Learning | nothing new | — |
| Caller Whale MCP | nothing new (`MCP_AUTH_TOKEN` is auth's `AUTH_MCP_TOKEN`) | — |
| Caller Whale Messaging | nothing new | — |
| Caller Whale Notifications | `NOTIFY_TOKENS`: add `crm-core=<token>` (T6) | Redeploy (the report, status, breach notice and support reply emails) |
| ClamAV (new, step 38) | A new container from the open-source `clamav/clamav` image (`stable` tag), on the same network with the alias `clamav`, no domain, `CLAMD_CONF_StreamMaxLength=30M`; it needs about 3 GB of memory and downloads its virus list on start | Then set crm-core's `CLAMD_ADDR=clamav:3310` and redeploy crm-core, billing (the storage limit) and the gateway (shared-file links) |
| The website (landing-web) | nothing new | Redeploy (the /status page and the outage banner) |

## Outside accounts and their settings

| # | Do | Then set | Turns on |
|---|---|---|---|
| S1 | Deploy the dialer (`dialer-sms-backend-production`) in Coolify, simulator first (`TELNYX_MODE=simulate`) | The rows of T1 to T3, T5 | Calls, texts, captions, opt-outs (steps 10, 21, 25, 26) |
| S2 | Telnyx: account, numbers, a messaging profile; each agency's 10DLC brand and campaign are now submitted from Caller Whale (step 39), so set `TELNYX_WEBHOOK_URL` to the dialer's public `/webhooks/telnyx` | dialer-sms `TELNYX_*` (see its example), then `TELNYX_MODE=live` | Real calls and texts. Check that STOP gets the carrier's own confirmation (D9) |
| S3 | OpenRouter account and key | assistant `OPENROUTER_API_KEY` | The website helper's AI and the in-app assistant |
| S4 | Google Cloud: a web OAuth client with the Calendar API, asking only `calendar.freebusy` and `calendar.app.created`; submit it for Google's verification | crm-core `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URL`, `GOOGLE_TOKEN_KEY` (`openssl rand -base64 32`), `APP_URL` | Google Calendar per person (step 28) |
| S5 | Amazon SES: an IAM user (send, create and check identities), production access out of the sandbox, the reply domain's MX to SES receiving, a receipt rule to an SNS topic (Base64), the topic subscribed to `https://<api>/api/v1/public/email/inbound` | crm-core `EMAIL_SES_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `EMAIL_PUBLIC_URL`, `EMAIL_REPLY_DOMAIN`, `EMAIL_SNS_TOPIC_ARN` | Email to leads and replies (step 29) |
| S6 | Redeploy the gateway (`gateway-backend-production`) | nothing | Google's return, email clicks, unsubscribe and inbound replies (steps 28, 29), and outside tools' keys (step 33) reaching the CRM |
| S7 | Phone alerts (step 42): install the ntfy app on both phones, each subscribe to a long random topic of your own | monitoring resource `PUSH_TARGETS` (owner=https://ntfy.sh/<topic>,cofounder=https://ntfy.sh/<topic>), `RELAY_TOKEN` (`openssl rand -hex 32`), optional `ONCALL_FROM` | Urgent alerts to whoever is on call |

## Switches and choices in the product

| # | Do | Why |
|---|---|---|
| P-1 | Turn `teams_v2` on for your agency (staff: `PUT /v1/orgs/{org}/features/teams_v2`), or `AUTHZ_FEATURES_EVERYWHERE=teams_v2` on authz for everyone | The new team rules (step 11) that later steps build on |
| P-2 | Right after crm-core with step 30 is deployed: as the owner, show full numbers to each team that still uses the old screens (`PUT /api/v1/teams/{id}/full-numbers {on: true}`) | Agents see "••• 1234" until the CRM screens get a call button that dials through the dialer |
| P-3 | Set the agency's time zone, postal address (`PUT /api/v1/email/settings`) and, if wanted, the AI's suggestions and required captions (`PUT /api/v1/ai-settings`) | Reports by your day; email needs the address; captions are off until switched on |
| P-4 | Turn commissions on only if you want them (`PUT /api/v1/commissions/settings`) | Off by default (step 27) |
| P-5 | Once the dialer runs live and your agency's registration is approved: crm-core `CARRIER_CHECK=on` | Imports wait for each agency's verified business (step 39). The dialer's own check is on from the start |

## For the lawyer (before real leads)

| # | Item | Where it is used |
|---|---|---|
| W-1 | The data processing agreement's text (now a draft version `2026-11-draft`) | Step 31: the owner accepts it |
| W-2 | The list of opt-out words, and "no calls from anyone" | Steps 25, 26 |
| W-3 | The recording notice per state | Step 21 |
| W-4 | The longest time recordings, captions and lead views may be kept | Steps 26, 30 |
| W-5 | The email footer (postal address, unsubscribe) and consent wording | Steps 25, 29 |
| W-6 | The words agencies send the carriers about how they text (campaign description, how people agree, sample texts), the referral consent (step 37) and the form consent (step 36) | Steps 36, 37, 39 |
| W-7 | Where the data is kept, for the terms and privacy notice: the European Union, currently France (Paris), perhaps Germany later; and that deleted data leaves backups within 30 days (D298, D370) | Step 41 |

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

# Step 18, part A: unpaid plans and closing an agency

| # | Do | Expect |
|---|---|---|
| G1 | As staff, give a throwaway agency a membership that ends today; open its Dashboard the next day as its owner | "Plan needs paying": everything keeps working until the date shown. A caller of the agency sees nothing yet. |
| G2 | Eight days later (or ask me to move its unpaid date back) | Everyone sees "read-only": reading and exporting work, calling, importing and inviting do not. |
| G3 | As the throwaway agency's owner (two-step sign-in), Dashboard → Close the agency | Members lose access at once; waiting invitations show as cancelled; "Reopen the agency" brings everything back. |

# Step 18, part B: choosing who keeps a seat

| # | Do | Expect |
|---|---|---|
| K1 | As staff, give a throwaway agency with three people a plan with 2 seats | Its owner's Dashboard shows "Choose who keeps a seat": keep up to 1 besides you. |
| K2 | Tick one person and press Keep these people | "1 suspended until a seat is free." The other person is suspended with the reason shown to them; restoring them is refused until a seat is added. |

# Step 19: support access

| # | Do | Expect |
|---|---|---|
| S1 | As a throwaway agency's owner, Dashboard → Support access → Let support in (24 hours) | "Support can come in until …". |
| S2 | As staff, staff area → Access | The agency is listed until that time; in the CRM it appears among your agencies, where you can read but not edit leads, export or open team chats. |
| S3 | As the owner, End support access now | Staff lose the agency at once; the record of people changes shows the grant, the visit and the end. |

# Step 25: do not call

Use throwaway agencies and the dialer's simulator (not yet deployed: run it locally as its README says).

| # | Do | Expect |
|---|---|---|
| D1 | In a throwaway agency, mark a lead "Do not call", then add another lead with the same number in another format | The new lead is do-not-call at once. A lead with that number in another throwaway agency is not. |
| D2 | As a caller, try to clear "Do not call" on that lead | Refused: the owner or an admin lifts it on the block list, with a reason. |
| D3 | As the owner, `POST /api/v1/blocks/lift` without a reason, then with one | The first is refused; the second lifts it, and `GET /api/v1/blocks` shows who marked, who lifted and why. |
| D4 | Log a "Do not call" call with "wants no calls from anyone", then add a lead with that number in a second throwaway agency | The second agency's lead is do-not-call; its check says the number is in Caller Whale's database. |
| D5 | From the second agency's owner, ask for a review with a reason; as staff, `GET /api/v1/platform/do-not-call`, then remove it with a reason | The review is listed with every mark; after removal the second agency may call the number, and the first agency's own block stays. |
| D6 | In the simulator, reply "Stop calling me" from a lead's number | Texts still go; the CRM blocks calls only. |
| D7 | Reply "Let's stop at that price" | The reply is marked as waiting; texting is refused until the sender chooses "not an opt-out" or "opt-out". |
| D8 | Reply "Leave me alone", then "START" | Texts and calls are blocked, then START lifts what the reply made (never a block a person made). |
| D9 | On a real 10DLC number (once live), text STOP | The carrier sends its own confirmation, and Caller Whale sends none. |

# Step 26, part A: scripts, call review, AI switches

| # | Do | Expect |
|---|---|---|
| A1 | As a throwaway agency's owner, write a script for a client; as a caller, try to write one | The owner's is saved; the caller is refused. |
| A2 | As a team's lead (the team works for that client), write the team's version; open a lead of that team as its caller | The caller reads the team's version; a lead of another team gets the client's script. |
| A3 | As the team's lead, score one of the caller's calls on two checklist items with a comment | The caller's "my reviews" shows it with the average; the team's reviews show the team and the caller's average. |
| A4 | As the caller, try to score your own call | Refused. |
| A5 | As the owner, switch the AI's suggestions on and require captions; as the team's lead, switch suggestions off for the team | The team's callers are told suggestions are off; captions are still required. |

# Step 26, part B: captions and call signals (simulator)

| # | Do | Expect |
|---|---|---|
| B1 | With the AI's suggestions off and captions not required, call a lead with scenario `callback` | No captions; nothing is pre-selected. |
| B2 | Switch the AI's suggestions on (owner) and call with scenario `callback` | Captions show "can you call me back tomorrow at 5?", a callback signal at 17:00 tomorrow (agency time), and "Callback" pre-selected. |
| B3 | During a call, `POST /sim/say` "stop all these companies calling me", then confirm the "anyone" signal | "Do not call" is pre-selected and logged; in the CRM the number goes to Caller Whale's database. |
| B4 | Pause the recording, have the lead say a line, resume | The line said while paused is not in the captions. |
| B5 | Set the keeping time to 7 days | Captions older than that disappear within a minute. |

# Step 26, part C: the in-app assistant (after the owner sets AGENT_TOKEN, ASSISTANT_URL/TOKEN and crm-core's BILLING_URL/TOKEN in Coolify)

| # | Do | Expect |
|---|---|---|
| I1 | As a caller in a throwaway agency, ask for a lead's summary | A short summary of its calls and notes; nothing is added to the lead. |
| I2 | Ask for a text draft, then save it | The draft can be edited; saved, it shows as a note "Text drafted with the assistant". |
| I3 | Ask for a text draft for a lead marked "Do not call" | Refused: the number is blocked. |
| I4 | Ask "how do I log a callback?" | An answer; nothing is kept on any lead. |
| I5 | Give the team an "ai" budget of 1 and ask twice | The second is refused with "budget ... used up". |
| I6 | After a captioned simulator call, ask for the call's summary | A summary and a suggested outcome; the outcome is pre-selected in the wrap-up. |

# Step 27: commissions

| # | Do | Expect |
|---|---|---|
| M1 | In a throwaway agency, open commissions before switching them on | "Commission tracking is off." |
| M2 | As the owner: switch on with a 20% split; callers 25 per appointment; one closer 10% of deals | Saved; an admin cannot change them. |
| M3 | A caller logs a call "Transfer"; the closer moves the lead's deal (fee 10,000) to Closed won | The caller sees 25 + 200; the closer 800; each sees only their own. |
| M4 | As the owner, override the closer's figure to 900 with a reason | The closer's total shows 900 with the reason. |
| M5 | Move the deal back to Negotiation | Its commission disappears. |

# Step 28, part A: pipeline, booking, credit

| # | Do | Expect |
|---|---|---|
| P1 | As a throwaway agency's owner, set stages "New offer, Signed"; as a team lead, try to change them | The owner's stick; the team lead is refused. |
| P2 | As a team lead, limit a closer to 09:00-17:00; as the closer, set 08:00-17:00, then 09:00-17:00 | The first is refused, the second saved. |
| P3 | As a caller of that team, list the team's slots and book one for a lead you work | The closer gets an appointment task at that time; booking the same slot again is refused. |
| P4 | A caller of another team lists those slots | Refused. |
| P5 | The closer moves the lead's deal to Closed won | The deal is credited to the caller and the closer; the lead shows Closed / Won and leaves the queues; commissions count the booking. |

# Step 28, part B: Google Calendar (after the owner creates the Google Cloud app and sets the GOOGLE_* settings and APP_URL)

| # | Do | Expect |
|---|---|---|
| G4 | As a closer, connect Google Calendar | Google asks only to see when you are busy and to manage a calendar Caller Whale creates; you return with "connected"; a "Caller Whale" calendar appears in Google. |
| G5 | Put a meeting in your own Google Calendar tomorrow at 10:00 | A caller of your team no longer sees your 10:00 slot. |
| G6 | A caller books one of your slots | An event "Caller Whale appointment" appears at that time; it holds only a link, which opens the lead in the right agency after sign-in. |
| G7 | Cancel the appointment | The event disappears. |
| G8 | Hand a suspended closer's work to another connected closer | The coming appointments and events move to the new closer's calendar. |
| G9 | Disconnect Google | The events leave your calendar and Google shows Caller Whale's access removed. |

# Step 29: email to leads (after the owner's SES setup and the EMAIL_* settings)

| # | Do | Expect |
|---|---|---|
| E1 | In a throwaway agency, email a lead before setting the postal address | Refused: set the agency's postal address first. |
| E2 | As the owner, set the address; add a sending domain you own; add its DNS records; check it | The records are listed (DKIM, SPF, DMARC); after DNS updates, the domain shows verified. |
| E3 | As a caller who works a lead with your own test address, send an email with a link | It arrives from team@yourdomain, ends with the agency's address and an unsubscribe link; the link opens the page and the click shows on the lead. |
| E4 | Reply to it from your test mailbox | The reply shows on the lead without the quoted email; after 15 minutes unanswered, the team's lead gets a task. |
| E5 | Open the unsubscribe link and press Unsubscribe | Sending to that address is refused for the agency. |

# Step 30: protecting leads

| # | Do | Expect |
|---|---|---|
| L1 | As an agent in a throwaway agency, open a lead | Its number shows as "••• 1234", in its calls too; calling through the dialer still reaches the real number. |
| L2 | As the agent, try to change that number | Refused: you see it masked. |
| L3 | As the owner, show the agent's team full numbers; reload as the agent | The full number shows. |
| L4 | As a team lead, export your team's leads; then as the owner allow it and try again; then try the whole agency | Refused, then a CSV of your team's leads, then refused. The owner sees each export in the record. |
| L5 | As the owner, open the agent's "what they looked at" and a lead's "who opened it" | The leads they opened with times, and their exports. |

# Step 31: setup, walk-throughs, material

| # | Do | Expect |
|---|---|---|
| F1 | As a new throwaway agency's owner, open the setup checklist | Name, hours, team, client, invite, authenticator, agreement; invite shows done once someone joined. |
| F2 | Rename the agency, skip hours, accept the agreement | Name and agreement done, hours skipped; an admin cannot accept the agreement. |
| F3 | As a caller, open the walk-through status, finish yours | Your role is listed until you finish it. |
| F4 | As a team lead, add material for your team and give it to a caller of your team, then to someone outside it | The first works, the second is refused; when the caller finishes it, you see it. |

# Step 32: overviews and reports (reports after the owner sets NOTIFY_MAIL_URL/TOKEN)

| # | Do | Expect |
|---|---|---|
| R1 | As a throwaway agency's owner, open the overview | What needs you today first (work to hand on, overdue callbacks by team, emails waiting), then today's calls and results. |
| R2 | As a team lead, open your team's overview and the dialer's waiting texts | Overdue callbacks, unassigned leads and emails waiting for your team; another team's is refused. |
| R3 | As the owner, open members' activity | Each member's last active day and days active this month. |
| R4 | As a team lead, schedule a weekly report for your team; wait until Monday (agency time) | An email with totals only and a link to the details. |
| R5 | As the owner, schedule a monthly report to a client's people | On the 1st, the client's people get the totals for their work only. |

# Step 33: keys and events (after the gateway is redeployed)

| # | Do | Expect |
|---|---|---|
| K3 | As a throwaway agency's owner, make a key "Web form" that adds leads to a team; try one that "makes calls" | The key shows once; the second is refused. |
| K4 | With the key, add a lead (`POST /api/v1/tools/leads`), then read it back | It waits unassigned in that team; reading a lead of another team answers not found. |
| K5 | Switch the key off and use it | Refused; the key's uses list each try, refused ones too. |
| K6 | Add an event address (for example a request-bin you own) for "deal won"; win a deal | A message with only the event, ids and time arrives, signed with the secret you were shown. |

# Step 34: status page and breach notices (after auth, notifications, gateway and the website are redeployed)

| # | Do | Expect |
|---|---|---|
| Z1 | Open callerwhale.com/status | Every part shows working; nothing in the last 30 days. |
| Z2 | Signed in, turn on status emails (`PUT /v1/me/status-emails {on: true}`); as staff, open an incident "Calls are down" for calls | The status page shows calls not working, every page shows the banner, and you get an email. |
| Z3 | As staff, resolve it with a note | The banner goes; the incident moves to the last 30 days with the note; you get a "Resolved" email. |
| Z4 | Set `STATUS_PROBES` on auth and stop a throwaway service it checks | After two minutes that part shows down; it comes back when the service does. |
| Z5 | As staff, send a breach notice to a throwaway agency (a practice run, as the breach plan asks once a year) | Its owner gets the notice; the list shows it went within 72 hours. |

# Step 35, part A: sign-in security (after auth, authz, notifications, gateway and the website are redeployed)

| # | Do | Expect |
|---|---|---|
| H1 | Sign in to a throwaway account from a browser it never used | An email "New sign-in" names the device and country; "This wasn't me" signs that device out and emails a reset link. |
| H2 | As a throwaway agency's owner, require an authenticator for everyone | A caller without one is asked to set it up before they can work. |
| H3 | Set the idle limit to 15 minutes; leave a member's tab closed for 20 minutes, then open it | They are signed out; with a call in progress they would not be. |
| H4 | As the owner, sign out a member; as an admin, try to sign out the owner | The member's devices are signed out; the admin is refused. |
| H5 | With an authenticator set up, reset your password with the email link alone, then with a recovery code | Refused, then done. |
| H6 | Ask support with the reset link (lost both); as staff, approve before and after 7 days | Refused before; after, the authenticator is removed and a reset link arrives. |

# Step 35, part B: Microsoft sign-in and place limits

| # | Do | Expect |
|---|---|---|
| H7 | In Firebase, turn on Microsoft (with an Azure app registration); open the sign-in page | "Continue with Microsoft" appears and signs you in; Profile can connect Microsoft. |
| H8 | As a throwaway agency's owner, limit it to your country and your office network (`PUT /v1/orgs/{org}/security {countries, networks}`) | A member working from another network is refused with "only from its office networks"; you, the owner, are not. |

# Step 36: website forms (after crm-core and the gateway are redeployed, with EMAIL_PUBLIC_URL set)

| # | Do | Expect |
|---|---|---|
| Y1 | As a throwaway agency's owner, make a form for a client and a team (`POST /api/v1/forms`) | You get its address and an embed snippet. |
| Y2 | Open the address on a phone; send it with the consent ticked | "Thank you"; a new unassigned lead of that client waits in that team, with the property and message as a note. |
| Y3 | Put the embed snippet on a page of a site you listed, then on another site | It shows on the listed site and is refused on the other. |
| Y4 | Send it with a number on the agency's block list | The lead comes in as do-not-call, and the form's submissions show it as blocked. |
| Y5 | Text the lead who ticked consent (through the dialer) | Allowed for that client; the same number under another client is not. |

# Step 37: sending a lead to another agency (after crm-core is redeployed)

| # | Do | Expect |
|---|---|---|
| Z1 | With two throwaway agencies A and B, as A's owner look up B's owner by Name#tag (`GET /api/v1/referrals/agencies`) | B's agency is listed. |
| Z2 | As A, send a lead with a note without confirming consent, then with it | Refused first; then A's lead shows Closed, "Sent to <B>". |
| Z3 | As B's owner, decline it with a reason | A's lead reopens with the reason as a note. |
| Z4 | Send again; as B, accept into a client | B has a new lead with the note; no calls, texts or A's notes came with it. |
| Z5 | Before sending, block texts to the number in A; after B accepts, try lifting that block in B | B's lead can't be texted, and B can't lift the block. |
| Z6 | Note a fee as A, agree as B, then win the deal in B | Both owners get a "Referral fee" task. A sees the close only after both turned on sharing. |

# Step 38: files on leads (after ClamAV runs, CLAMD_ADDR is set, and crm-core, billing and the gateway are redeployed)

| # | Do | Expect |
|---|---|---|
| F1 | As a caller holding a lead, upload a PDF | It shows "clean" within seconds and opens. |
| F2 | Rename a .exe to .pdf and upload it; upload a 30 MB PDF | Both refused. |
| F3 | Upload the EICAR test file (from eicar.org) saved as a .pdf that starts with `%PDF-` | It shows as harmful and can't be opened. |
| F4 | As the caller, try to share the PDF with clients; as the team's lead, share it | The caller is refused; the team lead can. The client sees it and opening it is listed in its activity with their name. |
| F5 | As the owner, make a link for "Title Co" for 1 day; open it in a private window; withdraw it; open again | It opens and the opening shows with the network; after withdrawing it says the link was withdrawn. |
| F6 | Give a throwaway agency a membership with "File storage on leads (MB)" of 1, then upload a 2 MB file | Refused: storage full. |

# Step 39: carrier registration and texting standing (dialer in simulate mode first, then live)

| # | Do | Expect |
|---|---|---|
| C1 | As a throwaway agency's owner, try a call and a text | Both refused: "opens once the carriers verify…". |
| C2 | Enter the business details (`PUT /api/v1/carrier`) and submit (`POST /api/v1/carrier/submit`) | In simulate mode the brand is verified and the campaign follows within minutes; calling opens first, then texting. Live, expect days. |
| C3 | Simulate mode: submit with a display name containing "Refused" | The state is brand_failed with the reason; correct it and submit again. |
| C4 | With crm-core `CARRIER_CHECK=on`, start an import in an agency not yet verified | Refused with the carrier message; allowed once verified. |
| C5 | As the platform owner with your second step, `GET /api/v1/platform/carrier` | Every agency's state and rates; support staff are refused. |
| C6 | (Simulate) have many leads reply STOP to an agency's texts | Its owner gets a "Texting warning" task; staff see it; days later limited, then suspended; the owner appeals; staff clear it and texting reopens. |

# Step 40: help and feedback (after auth, authz, notifications and the website are redeployed)

| # | Do | Expect |
|---|---|---|
| H1 | Open /help and search "texting" | Only the articles about texting show. |
| H2 | As a throwaway agency's owner, Dashboard → Support: write to support | It is listed as "Waiting for us". |
| H3 | As staff, Dashboard → Support and feedback: open it and reply | The owner gets an email and sees the reply; a caller of that agency gets "ask your owner" if they try. |
| H4 | As staff, publish a What's new note for callers, and one for the switch teams_v2 | A caller sees the first once on their dashboard; after the owner switches on "New team rules" under Settings → Early features, the second shows too. |
| H5 | Press "Send feedback" on a dashboard page and send a note | Staff see it with the page's path and version, no ids. |

# Step 41: backups and recovery (docs/plans/backups-and-recovery.md)

| # | Do | Expect |
|---|---|---|
| B1 | In Coolify, add an S3 storage outside the server and a daily backup of every PostgreSQL, keeping 30 | The next morning each database has a file in the bucket. |
| B2 | Download the newest CRM backup and run `node tools/restore-test.mjs --dump <file> --scratch <throwaway db> --expect crm.leads --log restore-tests.jsonl` | PASS with the tables and rows; repeat monthly for every database. |
| B3 | With a throwaway agency: restore yesterday's CRM backup into a copy, set `RESTORE_COPY_URL`, ask, confirm as its owner, run | Only that agency's leads go back to yesterday; another agency's are untouched; blocks made today stay; its devices reload. |

# Step 42: monitoring and alerts (after the monitoring resource, auth, the gateway and both web apps are redeployed, with S7 done)

| # | Do | Expect |
|---|---|---|
| M1 | Open Grafana → Alerting → Alert rules | 15 rules in "Caller Whale alerts", none in error. If any shows an error, tell me its message. |
| M2 | Stop the dialer in Coolify for 3 minutes, then start it | The on-call phone gets "dialer-sms is not answering", then "Fixed"; the other phone gets nothing unless the first push failed. |
| M3 | Stop the messaging service for 6 minutes at night, then in the day | At night nothing arrives until 07:00; in the day both phones get it. |
| M4 | On the website, open the browser console and run `setTimeout(() => { throw new TypeError("test") })` | In Grafana Explore, `{container=~".+"} |= "client_error"` shows the line with the page and kind, without "test". |
| M5 | Contact points → urgent-on-call → Test | The on-call phone gets a test push. |
