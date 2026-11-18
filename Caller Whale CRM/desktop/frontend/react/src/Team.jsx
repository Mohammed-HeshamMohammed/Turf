import { useMemo, useState } from "react";
import { CheckCircle, Handshake, Phone, UsersThree } from "@phosphor-icons/react";
import { ROLES, SIGN_IN } from "./data.ts";
import { capability, leadCounts, teamNames, visibleLeads, visibleTasks } from "./model.ts";

const ROLE_NAMES = { owner: "Agency owner", solo: "Solo operator", manager: "Team manager", caller: "Caller", closer: "Acquisitions / closer", client: "Client" };
import { useCrm } from "./context.jsx";
import { api } from "./remote/api.ts";
import { Avatar, Badge, Button, Card, PageHeader, money } from "./ui.jsx";
import { SignInMark } from "./SignInMarks.jsx";
import { TeamMonitor } from "./TeamMonitor.jsx";

/** Everyone on the team in one place: what they own, what is waiting on them and where to go next. */
export function Team() {
  const { state, navigate, notify } = useCrm();
  const finance = capability(state, "finance");
  // A solo operator who wants to add callers makes the same workspace an agency (step 17, D59, D203).
  const solo = Boolean(state.remote?.roles?.includes("solo"));
  const [upgrading, setUpgrading] = useState(false);
  const upgrade = async () => {
    if (!window.confirm("Make this workspace an agency? You stay its owner and also lead a first team named after you, which takes all your leads. Nothing is copied or lost, and you can then invite callers.")) return;
    setUpgrading(true);
    try {
      const result = await api.upgradeToAgency();
      notify(`Your workspace is now an agency. ${result.leads_moved} leads are in ${result.team?.name || "your first team"}.`);
      // The new roles and the first team come with a fresh start of the workspace.
      setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      notify(error.message || "The workspace could not be upgraded.");
    } finally {
      setUpgrading(false);
    }
  };

  const counts = leadCounts(state);
  const people = useMemo(() => {
    const leads = visibleLeads(state).filter(lead => lead.stage !== "Closed");
    const ids = new Set(visibleLeads(state).map(lead => lead.id));
    const tasks = visibleTasks(state).filter(task => !task.done);
    const calls = visibleLeads(state).flatMap(lead => lead.calls || []);
    return teamNames(state).map(name => {
      const member = state.remote ? (state.remote.people || []).find(person => person.name === name) : null;
      const role = member ? { name: (member.roles || []).map(key => ROLE_NAMES[key] || key).join(", "), title: "" } : Object.values(ROLES).find(item => item.person === name);
      const owned = leads.filter(lead => lead.assignee === name);
      const ownedCount = counts.owned(name);
      const ownedIds = new Set(owned.map(lead => lead.id));
      return {
        name,
        // From the server when connected; the sample workspace has its own.
        signIn: state.remote ? state.remote.people?.find(person => person.name === name)?.sign_in : SIGN_IN[name],
        title: role?.name || "Team member",
        group: role?.title || "",
        leads: ownedCount,
        tasks: tasks.filter(task => task.assignee === name).length,
        calls: calls.filter(call => call.agent === name).length,
        waiting: state.handoffs.filter(item => item.to === name && item.status === "Requested" && ids.has(item.leadId)).length,
        pipeline: state.deals.filter(deal => ownedIds.has(deal.leadId) && !deal.stage.startsWith("Closed")).reduce((sum, deal) => sum + deal.amount, 0),
      };
    });
  }, [state]);

  const unassigned = counts.unassigned;
  const openTasks = people.reduce((sum, person) => sum + person.tasks, 0);
  const activeLeads = people.reduce((sum, person) => sum + person.leads, 0);

  return (
    <>
      <PageHeader title="Team" description="Who owns what, and what is waiting on them.">
        {solo && <Button variant="primary" disabled={upgrading} onClick={upgrade}>{upgrading ? "Upgrading…" : "Make this an agency"}</Button>}
      </PageHeader>
      {state.remote && <TeamMonitor />}
      <div className="metrics-grid">
        {[
          ["People", people.length, "On this workspace", UsersThree],
          ["Active leads", activeLeads, "Owned across the team", Phone],
          ["Open next steps", openTasks, "Assigned and not completed", CheckCircle],
          ["Unassigned", unassigned, unassigned ? "Waiting for an owner" : "Every lead has an owner", Handshake],
        ].map(([label, value, detail, Icon]) => (
          <Card key={label} className="metric">
            <div className="metric-label">
              <span>{label}</span>
              <Icon size={20} weight="light" />
            </div>
            <strong>{value}</strong>
            <small>{detail}</small>
          </Card>
        ))}
      </div>
      {unassigned > 0 && (
        <p className="notice">
          {unassigned} {unassigned === 1 ? "lead has" : "leads have"} no owner yet.{" "}
          <button type="button" className="text-link" onClick={() => navigate("work/leads?assignee=Unassigned")}>
            Assign {unassigned === 1 ? "it" : "them"}
          </button>
        </p>
      )}
      <div className="team-grid">
        {people.map(person => (
          <Card key={person.name} className="team-person">
            <div className="team-person-head">
              <Avatar name={person.name} large />
              <div>
                <h2 className="named">
                  {person.name}
                  <SignInMark method={person.signIn} />
                </h2>
                <small>{person.group}</small>
                <Badge>{person.title}</Badge>
              </div>
            </div>
            <div className="team-stats">
              <button type="button" onClick={() => navigate("work/leads?assignee=" + encodeURIComponent(person.name))}>
                <span className="stat-label">Active leads</span>
                <span className="stat-value">{person.leads}</span>
              </button>
              <button type="button" onClick={() => navigate("work/tasks?assignee=" + encodeURIComponent(person.name))}>
                <span className="stat-label">Open steps</span>
                <span className="stat-value">{person.tasks}</span>
              </button>
              <div>
                <span className="stat-label">Calls logged</span>
                <span className="stat-value">{person.calls}</span>
              </div>
              <button type="button" onClick={() => navigate("work/handoffs")}>
                <span className="stat-label">Handoffs waiting</span>
                <span className="stat-value">{person.waiting}</span>
              </button>
            </div>
            {finance && (
              <div className="team-pipeline">
                <small>Pipeline on their leads</small>
                <strong>{money(person.pipeline)}</strong>
              </div>
            )}
            <div className="row">
              <Button onClick={() => navigate("work/leads?assignee=" + encodeURIComponent(person.name))}>See leads</Button>
              <Button onClick={() => navigate("work/tasks?assignee=" + encodeURIComponent(person.name))}>See tasks</Button>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
