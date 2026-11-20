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
| D210 | The owner, admins and team leads write text templates per client or team, with fields such as the lead's first name. Agents pick one and can edit it before sending. | 10 |
| D211 | A text can be scheduled. It is sent only inside the lead's allowed hours and is cancelled automatically if the number is blocked before then. | 10 |
| D212 | Only the owner, admins and team leads can send one message to many leads, within budgets and calling hours. Each lead still gets their own thread. | 10 |
| D213 | Each number is checked (mobile, landline, disconnected) the first time it is about to be used, paid from the budget. Landlines are not texted, disconnected numbers are marked, and the result is kept so a number is never paid for twice. | 21 |
| D214 | A lead not contacted for a long time (6 months to start) has its number checked against the reassigned-numbers database before the next contact. The lawyer confirms which countries need it. | 21, lawyer |
| D215 | When someone answers "wrong number", the number is removed from that lead and blocked for anyone tied to it. The lead stays, waiting for a new number. The person who answered is not added to anything. | 21 |
| D216 | The owner and admins see a health score for each sending number. A number starting to be flagged as spam is slowed automatically and the owner is told, before carriers block it. | 21 |
| D268 | Each agency registers its own texting brand with the carriers (US 10DLC). The owner enters the business details during setup and Caller Whale submits the registration. An agency cannot text until it is approved, so one agency's behaviour cannot get the others blocked. | 39 |
| D269 | Staff see each agency's complaint and opt-out rates. Above a threshold the owner is warned, then sending is limited, then the agency is suspended until staff review. Each step is recorded and the owner can appeal. | 39 |
| D270 | A new agency can set up, import and invite freely, but calling and texting open only after its business details pass the registration check, with a quick staff look for the first agencies. | 39 |
| D276 | The owner switches call recording on for the agency or for chosen teams. When it is on, Caller Whale plays or prompts the notice the lead's state requires (some states need everyone's consent). The lawyer confirms the wording. | 21, lawyer |
| D277 | An agent can pause and resume recording during a call. The recording shows where it was paused and for how long, and captions pause with it. | 21 |
| D278 | Team leads, admins and the owner record voicemail messages per client or team. An agent picks one on reaching a voicemail; it plays while the agent moves to the next call. | 21 |
| D279 | Agents dial one lead at a time; auto dial moves to the next after each outcome. Caller Whale does not dial several numbers at once, since abandoned calls are strictly limited by law. | 21 |
| D285 | Captions and the AI's call suggestions work in English at opening, with Spanish next. The app's own screens stay in English (D171). | 26 |
| D316 | Link clicks in emails to leads are recorded on the lead. Email opens are not tracked. | 29 |
| D317 | Every email to a lead carries an unsubscribe link and the agency's address. Unsubscribing blocks email to that address for the agency, like a text opt-out. | 29, lawyer |
| D318 | A lead's email reply goes into the lead's record, with the same wait-then-tell-the-team-lead rule as an unanswered text (D21). | 29 |
| D319 | Agents email leads only from the agency's or a client's domain (D161), never from a personal mailbox, so lead conversations never leave the agency with a departing agent. | 29 |
| D320 | The in-app assistant can summarise a lead's history, draft texts and emails (the agent edits and sends them; it never sends on its own), summarise each call afterwards with a suggested outcome for the agent to confirm, and answer "how do I" questions about Caller Whale. | 26 |
| D321 | Only AI services contracted not to train on or keep what is sent are used. | 24, 26 |
| D322 | Drafts and summaries an agent saves or sends become part of the lead's record. What the agent asked the assistant privately is not shown to anyone. | 26 |
| D323 | Assistant use is part of the AI feature's price (D289) and is drawn from team and client budgets, with a per-person daily cap against runaway use. | 26, 22 |
| D324 | An agency can agree to let Caller Whale learn from its data. Only general patterns are used, with every name, number, address and client detail removed. Raw calls and texts never leave the agency. D146 stays the rule for every agency that has not agreed. | 45 |
| D325 | An agency that agrees gets a lower price on AI features for as long as it keeps agreeing. | 45 |
| D326 | Before any of an agency's data is used: the owner signs a separate agreement in Caller Whale (not part of the general terms) and can withdraw it at any time; each client agrees for its own part; the lawyer checks that the agency's notice to leads covers this use; and a check confirms no personal details remain in the patterns. | 45, lawyer |
| D327 | When an agency withdraws, nothing new of theirs is used and the discount stops. Patterns already learned stay, which the agreement says up front. | 45 |
| D359 | When a lead asks to be called back ("call me at 5", "call me tomorrow"), the captions detect it and offer a callback with the time filled in, in the lead's time zone and inside calling hours. The agent confirms or changes it with one click. | 26 |
| D360 | When a lead agrees to meet during a call, the captions notice it and open the booking panel with the team's closers' free slots (D155), so the caller books during the call. | 26, 28 |
| D361 | When a call ends, its outcome is pre-selected from what was said. The agent confirms with one click or picks another. Quick outcomes still work as they do today. | 26 |
| D362 | Calls produce only practical signals with a clear action, such as "asked about price", "wants to sell soon" or "mentioned another buyer". People are not scored on mood. | 26 |
| D372 | Assistant use not about a lead (a "how do I" question) is charged to the workspace's general allowance, within the daily cap. Anything about a lead is charged to its team and client (D323). | 26, 22 |
| D161 | Email to a lead is sent from the agency's own sending domain, or from one connected for a client. Replies come back into the lead's record, not to a personal inbox. | 29 |
| D142 | Calling scripts belong to a client, written by the owner, admins or the managers working for that client. A team can keep its own version; agents cannot change scripts. The AI also suggests what to say for each lead, from the lead's data and from earlier calls: captions run in the background of every call, and the AI learns from how the previous calls went to help with the next one. | 26 |
| D143 | A manager or deputy can score a call recording against a short checklist and leave comments. The agent sees their own scores; the team's averages go into the manager's reports. | 26 |
| D144 | Commission tracking, if it can be built, is optional per agency: the owner sets rates and Caller Whale shows what each agent has earned. No payments are made through it. | 27 |
| D146 | What the AI learns from an agency's calls is used only inside that agency, and what it learns from one client's calls only for that client's work. Nothing crosses to another agency. Agencies can agree to share general patterns (D324). | 26 |
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
