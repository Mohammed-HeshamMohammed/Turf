# Do not call

**State:** plan only, nothing built. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

The three kinds of "do not call", Caller Whale's own database that learns from every agency's work, and who can take a number out.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D139 | "Do not call" has three kinds. **Asked this agency to stop:** blocked for that agency, every client and team. **On a registry or a known complainer:** added to Caller Whale's own database for every agency once confirmed (a second agency reports it, or staff check it). **Wants no calls at all:** added to Caller Whale's database for every agency. | 25 |
| D140 | Any number found to be a do-not-call number that is not yet in Caller Whale's database is added to it. The database learns from every agency's work. | 25 |
| D141 | Only Caller Whale staff remove a number from the database. An agency can ask for a review with a reason; each removal is recorded. | 25 |
| D113 | "Do not call" applies to the whole agency: the number is blocked for every team and for future imports. Only the owner or an admin can lift it. | - |

## Notes

- D139 replaces D113 where they differ: a "stop" said to one agency stays inside that agency; the other two kinds go platform-wide.
- Risk to keep in view: "wants no calls at all" is marked by one agent and then blocks the number for every agency. A mistake, or a person marking numbers to hurt other agencies, has a wide effect. The guards are the record of who marked each number, a watch on anyone marking unusually many, and staff removal (D141).
- For the lawyer: confirm the three kinds match calling law.
- The existing do-not-call code has not been read for this.
