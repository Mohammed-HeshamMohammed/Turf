# Teams, roles and leads

**State:** plan only, nothing built. Scope is the **web version**; the desktop app and other local apps are out of scope for now. Index and build order: [README.md](README.md).

How teams are built (managers, deputies, admins, agents in several teams), who holds which lead, and how leads move between people and teams.

## Decisions

| # | Decision | Step |
| --- | --- | --- |
| D43 | A team can have no manager, one, or several equal managers. Each manager can also name deputies, who can read and take over threads but not invite or change people. | - |
| D44 | A caller or closer can be in several teams of one agency and switches the view to the team they want to work in. The switch is a filter, not a lock: alerts for another team's lead still arrive, and opening one switches the view. | - |
| D45 | One person can hold several roles in an agency, for example a manager who also closes. One invitation can carry them. | - |
| D46 | A seat is one person in one agency, however many teams or roles they have. The same person in two agencies is one seat in each. | - |
| D49 | A lead belongs to one team and is assigned to one agent of that team. That team's managers see it; the agent's other teams do not. | - |
| D54 | Every member sees who is in the agency, with role and team. Contact details follow each person's own settings. | - |
| D59 | A solo operator who adds callers upgrades in place: the same workspace becomes an agency and keeps its leads, clients and history. | - |
| D62 | A deputy can be any member of the agency. Being a deputy shows that team's leads to them. | - |
| D63 | A team's managers and the owner name and remove its deputies. The owner sees every change. | - |
| D64 | Managers of a team cannot act on each other. Only the owner can. | - |
| D65 | Only the owner creates, renames and deletes teams. | - |
| D66 | A team can be deleted only when it has no members and no leads. The owner moves them first with the hand-on screen. | - |
| D67 | An agent taken out of one of their teams leaves that team's leads and threads with the team; its managers reassign them. The agent keeps their other teams' work. | - |
| D78 | An agent in several teams opens on the last team used, and has an "All my teams" view where each lead is marked with its team. | 11 |
| D97 | An agent can be in at most 5 teams of an agency (a starting number). | 11 |
| D98 | With several roles, including an agency's custom roles, a person can do what any of their roles allows. A restriction placed on the person always wins over a role. | 11 |
| D100 | An owner can name admins. An admin can do everything the owner can with people, teams and settings, but cannot change the plan, hand over or close the agency, or remove the owner. Wherever this plan says "the owner" for people, teams and settings, an admin can too. | 11 |
| D101 | The owner and admins can be assigned leads in any team without being added to it, and then take a seat like anyone who works leads. | 11 |
| D102 | Handing on a person's work covers their leads and lead threads, open tasks and callbacks (due times kept), open deals at their stage, and notes (which stay on the lead). Unsent drafts are discarded. | 12 |
| D108 | The owner and admins move a lead between any teams. A manager moves a lead only between teams they run. | - |
| D109 | A handoff from a caller to a closer stays inside one team. Sending a lead to another team's closer is a team move (D108). | - |
| D110 | An imported list belongs to the team chosen at import. The person importing picks a team they belong to or run; the owner and admins can import into any team. The leads start unassigned in that team. | - |
| D111 | Managers and deputies hand out a team's unassigned leads. Each team has a setting for whether its agents may also claim them. | - |
| D112 | When the same person or property is imported into a second team, that team sees "This lead already exists in another team" without the details. The owner or an admin chooses which team keeps it, or that both keep their own copy. | - |
| D114 | A manager who runs several teams gets the same team switch and "All my teams" view as agents (step 11). | - |
| D115 | A manager sees reports for the teams they run. Agency-wide totals and other teams' numbers are for the owner and admins. | - |
| D124 | By default an agent sees only their own leads. Each team can switch on "agents see the whole team's leads", read-only. | 20 |
| D125 | A team's managers can switch on a leaderboard for the team. Without it, each agent sees only their own numbers. | 20 |
| D154 | The owner or an admin sets the agency's pipeline stages. A client's work can have its own stages when it needs them. Teams and agents cannot change stages. | 28 |
| D155 | Closers have availability for appointments. A caller of the same team sees the free slots and who is responsible for each, and books one; the closer is notified and it appears on their calendar. If the closer is live on the call with the caller, they can help set the right time during it. | 28 |
| D156 | A closer manages their own free slots. The team's managers, admins and the owner can also set or limit the range of slots for a closer. | 28 |
| D157 | A closed deal is credited to everyone who worked it, by role: the caller who set it and the closer who closed it, with the team and the client. Reports and any commission use those records. | 28 |
| D158 | A person can connect their Google Calendar to their account. Caller Whale reads only when they are busy, not what the events are, so those slots are not offered, and adds Caller Whale appointments to their calendar. | 28 |
| D159 | A Google Calendar event for an appointment holds the time and a link back that opens the lead inside the right agency. Names and phone numbers stay in Caller Whale, so a personal calendar never holds an agency's lead data. | 28 |
| D160 | When a person leaves an agency, that agency's events are removed from their Google Calendar, and the appointments go to whoever receives their leads and appear on that person's calendar. | 28, 12 |
| D162 | The owner and admins can export any leads. A manager can export their own teams' leads only if the owner switches that on. Agents never export. Every export is recorded with who, what and when. | 30 |
| D163 | By default agents see only the last digits of a lead's phone number and call or text with a button. The owner can switch full numbers on per team. Managers and above always see them. | 30 |
| D164 | When a person opens or scrolls through far more leads than usual, the owner and admins are told and that person is slowed for a while. Nothing is blocked outright. | 30 |
| D165 | Each lead keeps a record of who opened it and when, visible to the owner and admins, kept for a set time. | 30 |
| D178 | On screen the role that runs a team is called "Team lead", and its deputy "Deputy lead". This plan's word "manager" means the team lead; the stored role key stays `manager`. | 11 |
| D179 | An agency can have at most 3 admins (a starting number). Staff can raise it for a large agency. | 11 |
| D180 | The team switch sits in the header beside the agency name and opens a short list with "All my teams". People in one team see no switch. | 11 |
| D181 | When the new team rules are switched on, every existing team keeps its lead and its members exactly as they are. The new abilities are simply available afterwards. | 11 |
| D182 | Work waiting to be handed on stays with the team leads, who can work it. The owner and admins get a reminder after a few days that it is still waiting. | 12 |
| D183 | Each team sets a maximum of open leads per agent. An agent at the limit cannot claim more until they finish or release some. | 20 |
| D184 | The record of people changes is kept 2 years. The record of who opened a lead is kept 90 days. The lawyer may adjust both. | 16, 30, lawyer |
| D217 | Every imported number is checked against the agency's do-not-call list, Caller Whale's own database and any registry the agency subscribes to, before any calls start. Blocked rows are kept but marked, and the import summary says how many. | 20, 25 |
| D218 | The checks at import are charged to the client the list is for and to the team it goes to. When there is no client budget, the agency's own allowance pays. The import shows the cost before it starts. | 20, 22 |
| D219 | The person who imported a list, or a team lead, can remove the whole list within 24 hours if none of its leads has been called, texted or edited. After that, leads are removed one by one. | 20 |
| D220 | One import can be as large as the agency's remaining lead allowance. Large files are read in parts and the person can keep working meanwhile. | 20 |
| D221 | The owner, admins and team leads can run skip tracing. An agent can ask for a lead to be traced, and a team lead approves. It is paid from the lead's client and team budget. | 20, 22 |
| D222 | A traced number that turns out to be blocked is saved on the lead, shown as blocked, and cannot be called or texted, so it is never paid for again. | 20, 25 |
| D224 | Each agency sets how long a lead nobody works is kept (for example 2 years without contact). Before deletion the owner gets a list and can keep any lead with a reason. The lawyer sets the longest period allowed. | 20, lawyer |
| D225 | The owner's overview opens with what needs them today: waiting hand-ons, seat requests, blocked invitations, budgets running low, numbers losing health, overdue callbacks across teams. Numbers and charts come below. | 32 |
| D226 | A team lead's overview opens with their team right now: who is available, on a call or on a break; unanswered lead texts; overdue callbacks; unassigned leads. Today's results come below. | 32 |
| D227 | The owner, admins and team leads can schedule a weekly or monthly report to themselves or to a client's people inside Caller Whale. The email holds totals only; the details open in Caller Whale. | 32 |
| D228 | Reports use the agency's time zone, so everyone sees the same numbers. A team with its own hours still reports in the agency's zone. | 32 |
| D229 | Whoever holds a lead sees everything done on it for that client, by anyone, so they never repeat a call or contradict an earlier promise. | 20 |
| D230 | The owner and admins define lead fields per agency or client. Team leads create tags for their teams. Agents fill fields and apply existing tags but create neither. | 20 |
| D231 | Two copies of the same person for the same client can be merged by a team lead, admin or owner. History, threads and numbers are combined, and the merge can be undone for 7 days. | 20 |
| D232 | Agents and team leads can archive a lead (reversible). Only the owner and admins delete permanently, with a confirmation. A person's request to be erased is handled by the owner. | 20, lawyer |

## Notes

- These decisions change rules the authorization service enforces today (`services/authz/tree.go`): exactly one team per caller or closer, at most one manager per team, and a manager who is not also a caller or closer.
- D112: when both teams keep a copy, the two copies are separate records with separate threads, and "do not call" still blocks both if either is marked (see the do-not-call file).
- Suggested and turned down, recorded so it is not raised again: a lock that makes a person select an active team before a lead thread can be opened. The team switch is a filter (D44).

## Teams, roles and seats

These change rules the authorization service enforces today (`services/authz/tree.go`): exactly one team per caller or closer, at most one manager per team, and a manager who is not also a caller or closer.

- **Managers.** A team has no manager, one, or several with equal rights. A team with no manager is run by the owner.
- **Deputies.** A manager or the owner can name deputies for a team. A deputy can read the team's lead threads and take them over. A deputy cannot invite, change roles, suspend or set limits.
- **Several teams.** A caller or closer can be in more than one team of an agency. The CRM shows a team switch that filters what is on screen. It is a filter, not a lock: an alert for another team's lead still arrives, and opening it switches the view.
- **Several roles.** A person can be a manager and also a closer or caller.
- **Manager rights with several managers.** Any manager of a team can suspend, restrict and set limits for that team's callers and closers, and invite into it. Two managers acting on the same person at once: the later change wins and both are recorded.
- **Seats.** One person in one agency is one seat, whatever their teams and roles.
- **Managers are equal (D64).** Managers of a team cannot suspend, restrict or remove each other; only the owner can.
- **Teams (D65, D66).** Only the owner creates, renames and deletes teams. A team with members or leads cannot be deleted; the owner empties it first with the hand-on screen. This also removes the "team deleted before acceptance" failure for an invitation into a team that still has people.
- **Deputies (D62, D63).** Any member of the agency can be a deputy of a team. The team's managers and the owner name and remove them.
- **Leaving one team (D67).** An agent taken out of one team leaves its leads and threads with that team.
- **"Their manager"** for an agent in several teams means the managers of the team the lead belongs to (D49).
- **Team chat (D52).** Each team has one automatic chat that follows the team's membership. It cannot be deleted while the team exists.
- **Directory (D53, D54).** Every member can see who is in the agency and start a chat with any of them.
- **Reasons and record (D57, D58).** A reason is optional and shown when written. The owner sees the whole record of people changes, managers their teams', each person their own.
- **Coming back (D56).** A removed person can be invited again and starts fresh.
- **Solo to agency (D59).** The same workspace is upgraded; nothing is copied or moved.
