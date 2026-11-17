# Questions for the lawyer

**State:** plan only, nothing built. Written from the plan's decisions on 2026-11-17. Index: [README.md](README.md).

Caller Whale is a web CRM for US calling agencies (US only at opening, D272). Each decision below is what the owner has decided; the lawyer is asked to confirm it is lawful, or say what must change, and to supply wording where marked. Decisions not listed here are product choices with no legal question attached.

Every item links to the file that holds it, where the surrounding decisions give context.

## AI and learning

| # | What we decided | Where |
| --- | --- | --- |
| D147 | Each agency sets how long call recordings and captions are kept, inside limits Caller Whale sets after the lawyer's review. Captions used for AI learning are deleted with the recording. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D326 | Before any of an agency's data is used: the owner signs a separate agreement in Caller Whale (not part of the general terms) and can withdraw it at any time; each client agrees for its own part; the lawyer checks that the agency's notice to leads covers this use; and a check confirms no personal details remain in the patterns. | [05-calls-and-budgets](05-calls-and-budgets.md) |

## Personal chats and reports

| # | What we decided | Where |
| --- | --- | --- |
| D99 | A person can download their profile, settings and personal chats. Agency data belongs to the agency and is exported by its owner. | [01-people-and-invitations](01-people-and-invitations.md) |
| D105 | Personal chats go live after teams and the name tag, once the lawyer's text is ready. The server's memory is checked before the second database is created. | [07-platform-and-rollout](07-platform-and-rollout.md) |

## Opt-outs and do not call

| # | What we decided | Where |
| --- | --- | --- |
| D132 | When a client stops working with the agency, lists the client supplied are exported to them and removed from the agency after a set time. Lists the agency supplied stay with the agency, no longer marked with that client. | [04-clients](04-clients.md) |
| D274 | Caller Whale checks the federal Do Not Call list for every agency, and state lists where a state keeps one. Each agency holds its own registry access, as the law requires per business, and Caller Whale uses it on their behalf. | [06-do-not-call](06-do-not-call.md) |
| D317 | Every email to a lead carries an unsubscribe link and the agency's address. Unsubscribing blocks email to that address for the agency, like a text opt-out. | [05-calls-and-budgets](05-calls-and-budgets.md) |

## Terms, agreements and consent

| # | What we decided | Where |
| --- | --- | --- |
| D254 | Before sending a lead to another agency, the sender must confirm the person agreed to be passed on. The confirmation is recorded with the date. The lawyer confirms the wording and when it is needed. | [02-teams-and-leads](02-teams-and-leads.md) |
| D276 | The owner switches call recording on for the agency or for chosen teams. When it is on, Caller Whale plays or prompts the notice the lead's state requires (some states need everyone's consent). The lawyer confirms the wording. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D298 | Data stays on the current server and its backups, and the terms state which country. A US region can be added later if large agencies require it. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D308 | The owner accepts a data processing agreement during first setup, since Caller Whale processes leads' data on the agency's behalf. A copy is kept in their settings. The lawyer writes it. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D309 | Small changes to the terms or privacy policy are announced in "What's new". Big changes must be accepted at the next sign-in before working, and the date each person accepted is recorded. | [07-platform-and-rollout](07-platform-and-rollout.md) |

## Data, retention and deletion

| # | What we decided | Where |
| --- | --- | --- |
| D75 | An agency's internal chat messages are kept while the agency exists. Lead threads follow the lead's record and the legal rules for texts. | [03-chats](03-chats.md) |
| D82 | Closing an agency: members lose access at once and are told. The owner can reopen it for 30 days and export the data. Then it is deleted, except what the law requires keeping. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D184 | The record of people changes is kept 2 years. The record of who opened a lead is kept 90 days. The lawyer may adjust both. | [02-teams-and-leads](02-teams-and-leads.md) |
| D206 | After 30 days of read-only with no payment, the agency is treated as closed (D82): members lose access, and the owner can still pay and reopen, or export, for 30 more days. Then it is deleted except what the law requires keeping. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D224 | Each agency sets how long a lead nobody works is kept (for example 2 years without contact). Before deletion the owner gets a list and can keep any lead with a reason. The lawyer sets the longest period allowed. | [02-teams-and-leads](02-teams-and-leads.md) |
| D232 | Agents and team leads can archive a lead (reversible). Only the owner and admins delete permanently, with a confirmation. A person's request to be erased is handled by the owner. | [02-teams-and-leads](02-teams-and-leads.md) |
| D236 | After a security breach affecting an agency's data, its owner is told within 72 hours of Caller Whale knowing, with what happened and what to do. Telling leads or authorities follows the law, which the lawyer sets out. | [07-platform-and-rollout](07-platform-and-rollout.md) |
| D310 | The owner has a tool for a lead's data request. It finds every record about that person in the agency, exports or deletes it, blocks the number if asked, and records the request and its date. | [07-platform-and-rollout](07-platform-and-rollout.md) |

## Calls, texts and recording

| # | What we decided | Where |
| --- | --- | --- |
| D119 | A manager or deputy can join an agent's live call: listen silently, speak only to the agent, or take the call over, by rank as in D76. The agent always sees that someone joined. Whether the lead must be told depends on the law where they are. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D151 | Calls and texts are blocked outside the allowed hours in the lead's own time zone. Caller Whale sets the legal window by the lead's location; an agency can make it shorter, never longer. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D214 | A lead not contacted for a long time (6 months to start) has its number checked against the reassigned-numbers database before the next contact. The lawyer confirms which countries need it. | [05-calls-and-budgets](05-calls-and-budgets.md) |
| D272 | At opening, calling and texting are for the US only. Other countries follow one by one, each with its own rules checked by the lawyer. | [06-do-not-call](06-do-not-call.md) |
| D279 | Agents dial one lead at a time; auto dial moves to the next after each outcome. Caller Whale does not dial several numbers at once, since abandoned calls are strictly limited by law. | [05-calls-and-budgets](05-calls-and-budgets.md) |

## Documents the lawyer is asked to write

- Terms of service and privacy policy covering personal chats, reports and shared learning (D9 in the build order: step 9).
- The data processing agreement owners accept at setup (D308).
- The separate agreement for shared AI learning (D326).
- Notices: recording consent by state (D276), the consent line on website forms (D247), consent before passing a lead to another agency (D254), the opt-out word list (D207).
- Retention periods: messages, recordings, records, stale leads, closed agencies (D75, D147, D184, D224, D82, D206).

## Questions already known to be open

- How long reported messages and report copies may be kept (D12, set at 90 days).
- Whether leads must be told when a manager joins a call (D119).
- What happens to a client's own lists when the client leaves (D132).
- Whether the three kinds of "do not call" (D139) and the platform database learning from every agency (D140) match calling law.
