# Do not call

**State:** plan only, nothing built. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

The three kinds of "do not call", Caller Whale's own database that learns from every agency's work, and who can take a number out.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D139 | "Do not call" has three kinds. **Asked this agency to stop:** blocked for that agency, every client and team. **On a registry or a known complainer:** added to Caller Whale's own database for every agency once confirmed (a second agency reports it, or staff check it). **Wants no calls at all:** added to Caller Whale's database for every agency. | 25 |
| D140 | Any number found to be a do-not-call number that is not yet in Caller Whale's database is added to it. The database learns from every agency's work. | 25 |
| D141 | Only Caller Whale staff remove a number from the database. An agency can ask for a review with a reason; each removal is recorded. | 25 |
| D207 | A reply that is only an opt-out ("STOP", "unsubscribe", "stop texting me") blocks the number for that agency at once, sends an automatic confirmation, and the thread shows why. The agent cannot override it; only the owner or an admin can, with a reason. | 10, 25 |
| D208 | A message that uses "stop" inside a normal sentence ("let's stop at that price") is flagged to the agent, with the AI's reading of whether it is an opt-out. The agent must choose "opt-out" or "not an opt-out" before sending anything else, and the choice is recorded. | 10, 25 |
| D209 | An opt-out says what it stops: "stop texting me" blocks texts, "stop calling me" blocks calls, "stop" or "leave me alone" blocks both. When unclear, both are blocked. | 10, 25 |
| D272 | At opening, calling and texting are for the US only. Other countries follow one by one, each with its own rules checked by the lawyer. | 21, 25 |
| D273 | Numbers outside supported countries are marked on import and cannot be called or texted until that country is supported. | 20, 25 |
| D274 | Caller Whale checks the federal Do Not Call list for every agency, and state lists where a state keeps one. Each agency holds its own registry access, as the law requires per business, and Caller Whale uses it on their behalf. | 25, lawyer |
| D275 | Registry access is its own cost in each agency's plan, priced as a feature of its own. | 25, 22 |
| D113 | "Do not call" applies to the whole agency: the number is blocked for every team and for future imports. Only the owner or an admin can lift it. *Replaced by D139 where they differ: a "stop" said to one agency stays inside it; registry and "no calls at all" numbers go platform-wide.* | - |

## Notes

- D139 replaces D113 where they differ: a "stop" said to one agency stays inside that agency; the other two kinds go platform-wide.
- Risk to keep in view: "wants no calls at all" is marked by one agent and then blocks the number for every agency. A mistake, or a person marking numbers to hurt other agencies, has a wide effect. The guards are the record of who marked each number, a watch on anyone marking unusually many, and staff removal (D141).
- For the lawyer: confirm the three kinds match calling law.
- The existing do-not-call code has not been read for this.

## Note on reading replies (D207 to D209)

The AI's reading of a reply is advice to the agent, never the decision on its own: a clear opt-out word blocks without waiting for it, and an unclear message waits for the agent's choice. This keeps a mistaken AI from either missing an opt-out or blocking a willing lead. Which exact words count as a clear opt-out is a list the lawyer should confirm.
