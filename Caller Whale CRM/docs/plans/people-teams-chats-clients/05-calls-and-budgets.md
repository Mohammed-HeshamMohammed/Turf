# Calls, scripts and budgets

**State:** plan only, nothing built. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

Phone numbers per team, recordings, joining a live call, scripts and the AI's suggestions, call review, commission, and how paid usage is shared and limited.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D116 | Each team has its own phone numbers, given by the owner or an admin. A team without one uses the agency's default number. | 21 |
| D117 | A lead that moves to another team keeps the number it already knows, so replies still arrive. New leads of a team use that team's number. | 21 |
| D118 | Call recordings and transcripts are open to the same people as the lead thread, and move with the lead. | 21 |
| D119 | A manager or deputy can join an agent's live call: listen silently, speak only to the agent, or take the call over, by rank as in D76. The agent always sees that someone joined. Whether the lead must be told depends on the law where they are. | 21, lawyer |
| D150 | When a lead calls back, it rings the agent assigned to that lead. If they are busy or away it rings the team's other available agents, then its managers, then goes to voicemail in the lead's thread. | 21 |
| D151 | Calls and texts are blocked outside the allowed hours in the lead's own time zone. Caller Whale sets the legal window by the lead's location; an agency can make it shorter, never longer. | 21, lawyer |
| D152 | Agents have a status: available, on a call (automatic), on a break, off (set by the agent). Inbound calls, unanswered-text alerts and assignments use it, and managers see their team's status. | 21 |
| D153 | A callback that comes due while its agent is away stays with the agent, flagged overdue. After the agency's wait time the team's managers and deputies are told and can give that one call to someone else. | 21 |
| D161 | Email to a lead is sent from the agency's own sending domain, or from one connected for a client. Replies come back into the lead's record, not to a personal inbox. | 29 |
| D142 | Calling scripts belong to a client, written by the owner, admins or the managers working for that client. A team can keep its own version; agents cannot change scripts. The AI also suggests what to say for each lead, from the lead's data and from earlier calls: captions run in the background of every call, and the AI learns from how the previous calls went to help with the next one. | 26 |
| D143 | A manager or deputy can score a call recording against a short checklist and leave comments. The agent sees their own scores; the team's averages go into the manager's reports. | 26 |
| D144 | Commission tracking, if it can be built, is optional per agency: the owner sets rates and Caller Whale shows what each agent has earned. No payments are made through it. | 27 |
| D146 | What the AI learns from an agency's calls is used only inside that agency, and what it learns from one client's calls only for that client's work. Nothing crosses to another agency. | 26 |
| D147 | Each agency sets how long call recordings and captions are kept, inside limits Caller Whale sets after the lawyer's review. Captions used for AI learning are deleted with the recording. | 26, lawyer |
| D148 | The owner switches the AI's call suggestions on for the agency, and a team's managers for the team. An agent can hide the suggestions on their own screen, but cannot turn off captions if the agency requires them. | 26 |
| D149 | If commission tracking is built, the owner sets the rules per role or person (for example a fixed amount per appointment for callers and a percentage of the deal for closers, with a split when both worked the lead) and can override any figure. | 27 |
| D120 | Paid usage (texts, call minutes, skip tracing credits) comes from the agency's allowance. The owner or an admin can give a team a monthly budget; a team without one draws from the pool. | 22 |
| D121 | A manager sets usage limits for their team's agents, within the team's budget. The owner and admins set anyone's. | 22 |
| D122 | A text or call is charged to the team that owns the lead, whoever sends it, including a takeover. | 22 |
| D123 | When a team's budget or a person's limit runs out, paid actions stop for them and they can ask the manager or owner to raise it. Replies from leads still arrive and can be read. | 22 |
| D135 | The owner or an admin sets a monthly budget per client. A text or call counts against both the lead's client and the lead's team. The client sees their own usage. | 22 |

## Notes

- D119: whether the lead must be told when a manager joins or records a call depends on the law where the lead is. For the lawyer.
- D142, not designed yet: how the AI learns from captions. Where the learning may be used is decided (D146). The assistant and call-helper code has not been read for this.
- D131 applies here: no AI can spend, raise a budget or change a plan (see the platform file).
