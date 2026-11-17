# Platform and rollout

**State:** plan only, nothing built. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

The web cache, shared devices, what plans and billing do to people, support access, limits on AI, and how every step is released and checked.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D4 | The web cache refreshes automatically; a manual reload stays as a fallback. | - |
| D38 | At sign-in the person chooses "This is my device" (the encrypted copy is kept) or "Shared device" (nothing is kept after sign-out or closing the tab). | - |
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

## Notes

- The owner named three kinds of AI, which the plan keeps apart: the outside AIs that manage the system through MCP (D130), the helpers that assist during calls, and the assistant a person asks for help with Caller Whale (D129). The call helpers follow D129 as well: they see only the call and the lead they are helping with.
- The billing service has not been read yet. D70 and D80 to D82 say what should happen, not how much work it is.

## Web cache

- **One slot per person per agency.** Each slot keeps what has loaded and where loading stopped, so loading resumes. Switching back does not start again.
- **Only one agency in memory.** A switch drops the previous agency's records, selection, search and filters. Drafts are kept per agency.
- **Automatic refresh, in layers:**
  1. Always: live updates and a quiet incremental refresh while the tab is visible.
  2. On events: switching back to an agency, the network returning, the tab returning after a while, a role or team change.
  3. Full re-read only when the position cannot be trusted (the server reports a gap, the app version changed, access changed) or at the daily access renewal.
  4. Never while there are unsynced changes, an open edit form or a call in progress. Updates apply row by row and keep scroll position and selection.
- **Manual "Reload everything"** stays.
- **Removal.** Losing access to an agency deletes that agency's slot. (Problem 20.)
