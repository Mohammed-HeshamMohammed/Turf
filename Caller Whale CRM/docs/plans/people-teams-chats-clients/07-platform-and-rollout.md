# Platform and rollout

**State:** plan only, nothing built. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

The web cache, shared devices, what plans and billing do to people, support access, limits on AI, and how every step is released and checked.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D4 | The web cache refreshes automatically; a manual reload stays as a fallback. The cache lives in the open tab only (D194). | - |
| D38 | At sign-in the person chooses "This is my device" (their sign-in is remembered, D188) or "Shared device" (they are signed out when the tab closes). On the web no lead data is ever saved in the browser either way (D194). | - |
| D70 | Handing over ownership completes only after the new owner adds their own payment method. The old owner's card is removed and never charged again. | 13 |
| D80 | When payment fails or the plan ends, a grace period (7 days to start) keeps everything working and warns the owner. After it, members can read but not work and invitations stop, until the owner pays. | 18 |
| D81 | Lowering the plan below the number of members cannot complete until the owner picks who keeps a seat. The others are suspended, not removed, and their work is handed on. *Settled by D365: treated like any suspension.* | 18 |
| D82 | Closing an agency: members lose access at once and are told. The owner can reopen it for 30 days and export the data. Then it is deleted, except what the law requires keeping. | 18, 9 (lawyer) |
| D83 | Caller Whale staff can open an agency's workspace only when its owner allows it, for a set time (24 hours to start). They do not see internal chats, every action is recorded, and the owner can end it early. | 19 |
| D129 | The in-app AI assistant reaches exactly what the person can: same agency, same teams, same leads, never more. It works only in the agency the person is currently in and never in personal chats. | 24 |
| D130 | An outside AI (ChatGPT, Claude, Gemini) connected through MCP can read and set things up for a person within that person's own rights. Inviting, removing, changing roles and deleting each need the person's confirmation inside Caller Whale. | 24 |
| D131 | Spending money always needs the person themselves, in Caller Whale. No AI, in-app or outside, can spend, raise a budget or change a plan, and there is no way around it. | 24 |
| D103 | The first thing built after the two invitation steps is teams and roles. | order |
| D104 | Each step has its own switch: on for the owner's agency first, then for everyone, and off again without a new release if something is wrong. | every step |
| D105 | Personal chats go live after teams and the name tag, once the lawyer's text is ready. The server's memory is checked before the second database is created. | order |
| D107 | Each step is checked by automatic tests and in the web app, then tried by the owner in their own agency with a second account, before it is switched on for everyone. | every step |
| D145 | The plan is kept in one folder: an index of every decision, and one file per area. | done |
| D166 | Everything in this plan is built before Caller Whale is opened to agencies. There is no smaller first release. | all |
| D167 | Until then the only people using it with real leads are the owner and a couple of friends. Each step that changes teams, roles or leads carries their existing people and data across, and they are told before it is switched on. | all |
| D168 | Every new screen works at phone width, as the CRM already does. A separate mobile app is not part of this plan. | all |
| D169 | Within building it all, the owner marked these as mattering most after the invitation fixes and teams and roles: leads by team and protecting leads, clients, the name tag and personal chats, and the web cache for several agencies. | order |
| D170 | A new agency owner meets a short guided setup: agency name and hours, first team, first client (or "own business"), inviting people, and the authenticator. Each step can be skipped and finished later from a checklist. | 31 |
| D171 | The app ships in English. New screens keep their words separate from the code so another language can be added later without rework, including right-to-left layout. | all |
| D173 | Each role gets a brief walk-through of its own screens on first sign-in. Managers and the owner can assign the agency's own material and see who finished it. | 31 |
| D188 | "This is my device" is remembered for 30 days. Owners, admins and team leads are asked for their authenticator code again every 7 days. A sign-in from a new place asks at once. | 15 |
| D189 | *Replaced by D194.* (It assumed the web app still saved an encrypted copy behind a device password; that was removed on 2026-11-10.) | 5, 15 |
| D194 | The web app saves no lead data in the browser and asks for no device password (as built on 2026-11-10). Its cache lives in the open tab and is gone on reload. The desktop app keeps its encrypted copy and device password, and is out of scope. | 5 |
| D199 | An ownership handover lapses if the new owner has not confirmed and added payment within 7 days; nothing changes. The old owner can cancel it at any time before then. | 13 |
| D200 | In a handover the old owner chooses their new role: admin, team lead, or leaving. The new owner can change it afterwards like anyone else's. | 13 |
| D201 | When an owner's account is disabled, only an existing admin of the agency can ask to take it over. Staff confirm the owner cannot be reached for 14 days and check the request before handing it over. | 13 |
| D202 | With support access granted, staff can see screens and change settings to fix a problem. They cannot edit, export or delete leads, message anyone, or spend money. | 19 |
| D203 | When a solo operator upgrades, a first team named after them is created, they become its team lead as well as the owner, and all their leads go into it. Their clients stay as clients of the agency. | 17 |
| D204 | During the grace period after a failed payment, only the owner and admins are told, by a daily email and an in-app banner. Members see a plain notice only once the agency is read-only. | 18 |
| D205 | A read-only agency can be read, and replies from leads still arrive and are stored. Nothing can be sent, called, imported or exported, and no one can be invited. *Export is allowed even when read-only (D364).* | 18 |
| D206 | After 30 days of read-only with no payment, the agency is treated as closed (D82): members lose access, and the owner can still pay and reopen, or export, for 30 more days. Then it is deleted except what the law requires keeping. | 18, lawyer |
| D233 | The owner or an admin can create a key for one outside tool, limited to what it needs (for example "add leads to Team A for Client X"). Every key can be switched off, its use is recorded, and no key can spend money. | 33 |
| D234 | The owner can choose events (a lead booked, a deal closed) to send to an address of theirs. Each message carries only the event and an ID; details are fetched with a key, so nothing personal travels unasked. | 33 |
| D235 | A public status page shows each part (sign-in, calls, texts, chats). When something is down, everyone signed in sees a short banner, and owners can choose to get an email. | 34 |
| D236 | After a security breach affecting an agency's data, its owner is told within 72 hours of Caller Whale knowing, with what happened and what to do. Telling leads or authorities follows the law, which the lawyer sets out. | 34, lawyer |
| D266 | The owner can export the agency's leads, history, notes, tasks and files (and recordings, if kept) in common formats at any time and when closing. *Including while read-only (D364).* | 18 |
| D267 | The owner sees each member's last sign-in, days active this month and the seats in use, so unused seats can be freed. Nothing beyond what reports already count is tracked. | 32 |
| D271 | Only the platform owner and cofounder, with a second step, see across agencies: agency-level numbers such as complaint rates, spend and seats, never lead details. Narrower staff roles (support, billing, moderation) come when there is a team. | 39 |
| D284 | Every new screen meets WCAG AA: it works with a keyboard and a screen reader, keeps readable contrast, and allows larger text without breaking. This is checked as part of each step. | all |
| D287 | With no connection, the open tab keeps what it has loaded and keeps typed notes and drafts in memory, and sends changes when the connection returns. Since nothing is saved in the browser (D194), closing the tab while offline loses unsent work, with a warning first. | 5 |
| D288 | Personal chats are free for every account. They belong to the person, so no agency pays for them; Caller Whale carries their cost. | 6 |
| D289 | Each of these is priced as its own feature: call recording and its storage, AI call suggestions and captions, number checks and reassigned-number checks, and files on leads beyond a free amount. | 21, 26, 38 |
| D290 | Client and partner people stay free seats, up to a generous number per client (10 to start), since they never call or text. Above that the owner asks Caller Whale. | 23 |
| D291 | Each step records what its feature costs Caller Whale to run. The sell price is set when the step is built and its real cost is known, in line with pricing each feature on its own. | every step |
| D292 | Everyone has searchable help pages and the in-app assistant. Owners and admins also get a support conversation with Caller Whale staff. Members ask their owner first. | 40 |
| D293 | When a step is switched on, the people it affects see a one-time "What's new" note for their role. Owners get a fuller list. | 40 |
| D294 | Owners can switch on early features for their agency from settings, knowing they may change. This uses the per-step switches (D104). | 40 |
| D295 | A "Send feedback" button on every page sends the person's note with the page they were on and the app version. No lead data is attached. | 40 |
| D296 | Every database, including the personal chats database, is backed up daily to storage outside the VPS and kept 30 days. A restore is tested every month. | 41 |
| D297 | Staff can restore one agency's data from a backup without touching any other agency, after the owner confirms. Each restore is recorded. | 41 |
| D298 | Data stays on the current server and its backups, and the terms state which country. A US region can be added later if large agencies require it. | 41, lawyer |
| D299 | A second server (or a managed database) is planned so one failure does not stop calling and texting for every agency, but it does not delay opening. | 41 |
| D300 | Grafana watches sign-in, calls, texts, chats and the databases. When something fails or slows, an alert goes to the platform owner and cofounder by push notification or email, with a link to the logs. | 42 |
| D301 | The owner and cofounder take turns on call each week. Only urgent alerts (calls, texts or sign-in down) wake anyone; the rest wait for the morning. | 42 |
| D302 | Opening a lead or a list appears within a second, and saving an outcome or sending a text answers within half a second, for most people. Slower than that triggers an alert. | all |
| D303 | Errors in the web app are sent automatically with the page and version, stripped of names, numbers and message text, alongside the server's Runtime Logs table. | 42 |
| D304 | An outside security tester checks sign-in, the separation between agencies, personal chats and the gateway before any real agency joins. What they find is fixed first. | 43 |
| D305 | A set of automatic tests signs in as people of different agencies and tries every way to read another agency's leads, chats and files. Any change that lets one through fails before it ships. | all |
| D306 | Every secret has a written way to change it. Secrets are changed yearly, and at once if a person who knew them leaves or a leak is suspected. | 43 |
| D307 | The 3 high-severity weaknesses GitHub reports in outside libraries are fixed before the first build step. After that, updates are reviewed monthly and serious ones within a week. | 43 |
| D308 | The owner accepts a data processing agreement during first setup, since Caller Whale processes leads' data on the agency's behalf. A copy is kept in their settings. The lawyer writes it. | 31, lawyer |
| D309 | Small changes to the terms or privacy policy are announced in "What's new". Big changes must be accepted at the next sign-in before working, and the date each person accepted is recorded. | 40, lawyer |
| D310 | The owner has a tool for a lead's data request. It finds every record about that person in the agency, exports or deletes it, blocks the number if asked, and records the request and its date. | 44, lawyer |
| D311 | A Caller Whale account needs its holder to be 18 or older, confirmed at sign-up, as the terms say today. Personal chats follow the same rule. | - |
| D312 | One agency is built and tested to stay fast up to 200 people, 50 teams and 1 million leads. Larger agencies talk to Caller Whale first. | all |
| D313 | Anyone can open a sample agency with made-up teams, leads and chats to explore every screen. Real calling, texting and imports need a paid plan and the carrier check. | 31 |
| D314 | Before paying, an owner can create teams and clients and invite people. Nobody can call, text or import real leads until the plan is paid and the carrier check passes. | 31 |
| D315 | The sample agency runs on made-up data inside the person's own tab, as the CRM's sample workspace does today. Nothing from it ever reaches the real databases. | 31 |
| D328 | Teams, members, invitations, clients and agency settings move into the CRM at app.callerwhale.com, where the work is. The website Dashboard keeps sign-up, the person's account, plans and billing. | 3, 11 |
| D329 | The invitation link opens the CRM, which shows and accepts it. The website Dashboard still lists pending invitations too, so nobody gets stuck. | 1, 3 |
| D330 | Clients sign in to the same CRM and see a simplified view with only their own pages, under the agency's branding (D172). | 23 |
| D331 | Platform staff screens (the report queue, agencies, support access) stay in the website Dashboard's existing staff area, away from agencies' work. | 7, 19, 39 |
| D338 | The switched-off "system admin" platform role is removed. The narrow staff roles (support, billing, moderation, D271) take its place when there is a team. | 11 |
| D340 | A Duo agency is created with one team and both people as owner and admin. Team leads, deputies and team screens stay hidden until it moves to the Team plan. | 17 |
| D341 | Moving from Duo to Team upgrades the same workspace in place, like the Solo upgrade. The team screens, roles and invitations appear, and the two people keep owner and admin. | 17 |
| D342 | One person can run a Solo workspace and own a Team agency at the same time, as separate workspaces each billed on its own (D69). | - |
| D343 | Screens say "workspace" everywhere, since a Solo operator is not an agency. The website and pricing talk about agencies. In this plan "agency" means a workspace. | all |
| D344 | The person who opened a workspace is called "Owner" on screen. | all |
| D345 | Screens show each person's role (Caller, Closer, Researcher) and use no group word for them. Where a group is needed, "team members". The plan's word "agents" stays inside the plan. | all |
| D346 | Every step uses the on-screen words in the glossary in README.md. | all |
| D347 | The owner and admins change workspace settings. Team leads can read the settings that affect their team (hours, limits, claim rules) but not change workspace-wide ones. Everyone else sees only what affects them. | 11 |
| D348 | A team lead changes the team-level settings already decided as theirs (claim limit, leaderboard, whole-team view). The team's hours and full phone numbers stay with the owner and admins. | 11 |
| D349 | Settles the D265 contradiction: agencies never see or get compared on each other's leads, people or work. The only things that cross agencies are blocked numbers in Caller Whale's do-not-call database (D139, D140) and patterns from agencies that agreed to shared learning (D324). | all |
| D350 | Settles the D74 contradiction: an announcement marked important breaks through quiet hours (D85) and category settings (D40), like account and security alerts. Only the owner, admins and team leads can mark one important, so it should be rare. | 14, 16 |
| D364 | Settles D205 against D266: the owner can export the workspace's data at any time, including while it is read-only. Only working (calls, texts, imports, invitations) stops. | 18 |
| D365 | Settles D81 against D26: members suspended because the plan was lowered are treated like any suspension. Their team leads hold their work and can act on it, and it returns if the seat comes back. The owner can still hand it on. | 12, 18 |
| D368 | Settles D47 against D328 and D329: when the invitation link reaches the CRM with no account, the CRM opens the website sign-up with the email filled in and locked, then returns the person to the invitation in the CRM to accept. | 1, 15 |
| D370 | Deleted data leaves the backups within 30 days, and the terms and privacy policy say so. A restore never brings back data deleted on a person's request: it is deleted again after any restore. | 41, lawyer |
| D374 | The plan was wrapped up on 2026-11-17 after a full review of every decision. Anything decided later is added as a new decision and checked against the earlier ones. | - |
| D332 | Step 1's server changes (agency name, delivery states, masked address, links) are done now. Their screens are built directly in the CRM when the people screens move, so nothing is built twice. The current Dashboard screens get only small wording fixes. | 1 |
| D333 | In the CRM, members, teams, invitations and clients form one "Team" section in the sidebar for those who manage people. Agency settings (hours, numbers, limits, branding) go under Workspace settings in the Caller Whale menu. | 3, 11 |
| D334 | An agent sees only the directory in the Team section: names, roles and teams of everyone in the agency, to start a chat. No invitations or management actions. | 16 |
| D335 | The Dashboard's member and invite panels keep working until the CRM screens are switched on for everyone. Then they are removed and link to the CRM. | 3, 11 |

## Notes

- The owner named three kinds of AI, which the plan keeps apart: the outside AIs that manage the system through MCP (D130), the helpers that assist during calls, and the assistant a person asks for help with Caller Whale (D129). The call helpers follow D129 as well: they see only the call and the lead they are helping with.
- The billing service has not been read yet. D70 and D80 to D82 say what should happen, not how much work it is.

## Web cache

- **Memory only (D194).** Since 2026-11-10 the web app saves nothing in the browser and asks for no device password (commit `959c2bf3`; the desktop app keeps both). Everything below lives in the open tab and is gone when the tab is reloaded or closed. This matches the owner's original wish: the cache holds what the person needs until they reload.
- **One agency at a time.** A switch drops the previous agency's records, selection, search and filters from memory. Unsent drafts are kept per agency for the life of the tab.
- **Automatic refresh, in layers:**
  1. Always: live updates and a quiet incremental refresh while the tab is visible.
  2. On events: switching back to an agency, the network returning, the tab returning after a while, a role or team change.
  3. Full re-read only when the position cannot be trusted (the server reports a gap, the app version changed, access changed) or at the daily access renewal.
  4. Never while there are unsynced changes, an open edit form or a call in progress. Updates apply row by row and keep scroll position and selection.
- **Manual "Reload everything"** stays.
- **Removal.** Losing access to the agency in the open tab clears it from memory at once and returns the person to their other agencies or the "not invited" screen.

## What "build it all before opening" waits on

D166 means the opening date is set by the slowest of these, none of which is only code:

- **The lawyer:** terms and privacy text for personal chats and reports, retention periods, telling a lead about a joined or recorded call, client lists on leaving, calling hours, and the three kinds of "do not call".
- **The SMS and calling stage:** lead threads, takeover, team numbers, live calls, inbound routing and budgets (steps 10, 21, 22) cannot be finished before texts and calls themselves work.
- **Google's review:** connecting Google Calendar needs Google to approve the app.
- **Carrier registration:** each agency's texting brand must be approved by the carriers (D268), which takes days to weeks per agency.
- **Services not yet read for this plan:** billing, the dialer, imports, the assistant and call helpers, mail, calendar and deals, and the existing do-not-call code. Until they are read, those steps say what should happen, not how long they take.

The order of work in the index still applies inside D166: the steps the owner marked in D169 come first, so the parts that can be tried early are tried early.
