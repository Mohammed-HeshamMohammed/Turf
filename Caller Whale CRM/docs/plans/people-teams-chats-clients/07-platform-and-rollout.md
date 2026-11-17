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
| D81 | Lowering the plan below the number of members cannot complete until the owner picks who keeps a seat. The others are suspended, not removed, and their work is handed on. | 18 |
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
| D205 | A read-only agency can be read, and replies from leads still arrive and are stored. Nothing can be sent, called, imported or exported, and no one can be invited. | 18 |
| D206 | After 30 days of read-only with no payment, the agency is treated as closed (D82): members lose access, and the owner can still pay and reopen, or export, for 30 more days. Then it is deleted except what the law requires keeping. | 18, lawyer |
| D233 | The owner or an admin can create a key for one outside tool, limited to what it needs (for example "add leads to Team A for Client X"). Every key can be switched off, its use is recorded, and no key can spend money. | 33 |
| D234 | The owner can choose events (a lead booked, a deal closed) to send to an address of theirs. Each message carries only the event and an ID; details are fetched with a key, so nothing personal travels unasked. | 33 |
| D235 | A public status page shows each part (sign-in, calls, texts, chats). When something is down, everyone signed in sees a short banner, and owners can choose to get an email. | 34 |
| D236 | After a security breach affecting an agency's data, its owner is told within 72 hours of Caller Whale knowing, with what happened and what to do. Telling leads or authorities follows the law, which the lawyer sets out. | 34, lawyer |
| D266 | The owner can export the agency's leads, history, notes, tasks and files (and recordings, if kept) in common formats at any time and when closing. | 18 |
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
