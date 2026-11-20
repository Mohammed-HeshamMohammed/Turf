# Do not call

**State:** built 2026-11-18 on the server (CRM and dialer): see step 25 in [README.md](README.md) for what is left. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

The three kinds of "do not call", Caller Whale's own database that learns from every agency's work, and who can take a number out.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D139 | "Do not call" has three kinds. **Asked this agency to stop:** blocked for that agency, every client and team. **On a registry or a known complainer:** added to Caller Whale's own database for every agency once confirmed (a second agency reports it, or staff check it). **Wants no calls at all:** added to Caller Whale's database for every agency. | 25 |
| D140 | Any number found to be a do-not-call number that is not yet in Caller Whale's database is added to it. The database learns from every agency's work. *Settled by D363: registry numbers stay per agency.* | 25 |
| D141 | Only Caller Whale staff remove a number from the database. An agency can ask for a review with a reason; each removal is recorded. | 25 |
| D207 | A reply that is only an opt-out ("STOP", "unsubscribe", "stop texting me") blocks the number for that agency at once, sends an automatic confirmation, and the thread shows why. The agent cannot override it; only the owner or an admin can, with a reason. | 10, 25 |
| D208 | A message that uses "stop" inside a normal sentence ("let's stop at that price") is flagged to the agent, with the AI's reading of whether it is an opt-out. The agent must choose "opt-out" or "not an opt-out" before sending anything else, and the choice is recorded. | 10, 25 |
| D209 | An opt-out says what it stops: "stop texting me" blocks texts, "stop calling me" blocks calls, "stop" or "leave me alone" blocks both. When unclear, both are blocked. *Settled by D351.* | 10, 25 |
| D351 | Settles the D209 contradiction: a strong refusal to one agency ("leave me alone", "never call me again") blocks that agency for texts and calls. Only a clear statement of wanting no calls from anyone ("stop all these companies calling me"), confirmed by the agent, goes to Caller Whale's database for every agency. | 10, 21, 25, 26 |
| D352 | Opt-outs are detected automatically wherever the lead speaks or writes: in call captions during a call, and in texts and emails. A detected opt-out is marked at once with its kind (this agency, or anyone), and the agent gets a confirmation button. Clear opt-out words still block at once (D207); the detection's reading is advice, never the decision on its own. | 21, 25, 26 |
| D353 | A lead is texted only with consent on record. Consent can come from: a website form (D247), an earlier reply from the lead, the agent marking it during a call, or the agency confirming per list that it holds consent. Cold leads with none of these can be called but not texted. | 10, 25, lawyer |
| D354 | Caller Whale trusts the agency and the agent for consent it cannot verify, such as a lead on the phone saying "I'm driving, text me". The agent marks "Agreed to texts", with the date, who marked it, and the recording or captions linked when there are any. Responsibility for consent the agency or agent confirmed stays with the agency, as the terms say. | 10, 25, lawyer |
| D355 | An agency can confirm on import that it holds consent for a list. The confirmation is recorded with who gave it and when, and covers that agency only. | 20, 25, lawyer |
| D356 | Consent belongs to one agency and one number. Each agency holds its own consent for the same number, and one agency's consent never lets another agency text it. *Settled by D366: per client within the agency.* | 25 |
| D357 | Each lead has a primary phone and a primary email. Consent and blocks belong to each number or address, so a blocked number never blocks the lead's others unless the lead asked. | 20, 25 |
| D358 | Consent stays until the lead opts out. If a lead has not been contacted for 6 months (as for reassigned numbers, D214), consent is re-confirmed on the next call before texting. | 25 |
| D363 | Settles D140: numbers on a do-not-call registry are checked through each agency's own registry access and never copied into Caller Whale's shared database. The shared database holds only numbers whose owners said "no calls from anyone" to a Caller Whale agency (D351) and confirmed known complainers. | 25, lawyer |
| D366 | Settles D356 against D223: consent to text belongs to one client's work within an agency, and one number. Working the same number for another client needs its own consent. Opt-outs still block the whole agency (D139). | 25, lawyer |
| D367 | When a lead asks to be deleted, their record, history and files are deleted. Only the number and email stay on the agency's block list, with the date and "deleted on request", so they are never contacted again. | 44, lawyer |
| D373 | Consent to text never travels with a lead sent to another agency. Blocks do (D251); the receiving agency gathers its own consent. | 37 |
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

## Note on consent the agency confirms (D354, D355)

Trusting the agency's or agent's word is the owner's choice, made knowingly: not every consent can be checked (a lead saying "text me" while driving). Caller Whale's protection is the record: every confirmation says who, when, for which number and which agency, and links any recording. If an agency confirms consent it does not hold, the terms place the responsibility on that agency, and the complaint and opt-out rates (D269) catch agencies that do it often. The lawyer should confirm the terms can carry that responsibility.
