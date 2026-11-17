# Clients

**State:** plan only, nothing built. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

A client is the person or business that hired the agency to work for them. It is not a lead reached by cold calling. This file covers how work is organised by client and what a client sees.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D126 | Every list and lead belongs to a client. A list is marked at import with the client it is for and with who supplied it: the client, or the agency. An agency working only for itself has one built-in "own business" client. | 23 |
| D127 | A client who signs in sees: results and reports for their work (no names or phone numbers), the leads or briefs the agency shared with them, a conversation with the agency, and the usage and cost of their work. | 23 |
| D128 | A team can work for several clients. A lead carries both a team and a client. The team's agents see leads of every client the team works for; a client never sees the agency's other clients. | 23 |
| D132 | When a client stops working with the agency, lists the client supplied are exported to them and removed from the agency after a set time. Lists the agency supplied stay with the agency, no longer marked with that client. | 23, lawyer |
| D133 | The same person or property in two clients' lists is two separate records with separate histories. Neither client can learn the other has it. The owner and admins see a quiet marker that it exists twice. | 23 |
| D134 | The agency invites a client's main contact. That person adds and removes their own colleagues, who see the same client view. All are free seats. | 23 |
| D136 | A client hears a recording or reads a conversation only when the owner, an admin or the lead's team managers share that specific one. | 23 |
| D137 | Each client has one conversation with the people the agency names for them: the owner, admins and chosen managers. Agents are in it only if added. | 23 |
| D138 | The agency can send the calling script and the list summary to the client for approval. Whether approval is required before work starts is a setting per client. | 23 |
| D223 | A lead's data is never shared between the agency's clients. A number traced or a note written for one client's lead is never used for another client's copy, and each client pays for its own. | 23 |
| D245 | A partner is another business working on the same deals as the agency, for example a lender, a title company or another agent who helps close a client's deals. Partners see only what is shared with them on specific leads, and are free seats. | 23 |
| D246 | A client who hired two agencies has one sign-in and a switcher, like anyone in several agencies. Each agency sees only its own work for them, and neither knows about the other. | 23 |
| D247 | The owner can create a website form (a link or an embed) for a client. Each submission becomes a lead for that client in a chosen team, is checked against the block lists, and records the person's consent. | 36 |
| D255 | A partner sees the details and documents shared with them on a lead and can message the agency in that lead's partner thread. Partners never call or text the lead through Caller Whale. | 23 |
| D172 | The client's screens, reports and emails show the agency's name and logo, with a small "Powered by Caller Whale". | 23 |
| D94 | The owner invites any client or partner. A manager can invite a client only to share things belonging to their own teams. | 3 |

## Notes

- D94 replaces the earlier limit that a manager cannot invite a client.
- D132 and the lawyer: who supplied a list decides who may take it away. The periods and the wording belong in the contract and privacy review.
