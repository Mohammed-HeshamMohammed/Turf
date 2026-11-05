import { useMemo } from "react";
import { CheckCircle, Handshake, Phone, UsersThree } from "@phosphor-icons/react";
import { PEOPLE, ROLES, SIGN_IN } from "./data.js";
import { capability, visibleLeads, visibleTasks } from "./model.js";
import { useCrm } from "./context.jsx";
import { Avatar, Badge, Button, Card, PageHeader, money } from "./ui.jsx";
import { SignInMark } from "./SignInMarks.jsx";

/** Everyone on the team in one place: what they own, what is waiting on them and where to go next. */
export function Team() {
  const { state, navigate } = useCrm();
  const finance = capability(state, "finance");

  const people = useMemo(() => {
    const leads = visibleLeads(state).filter(lead => lead.stage !== "Closed");
    const ids = new Set(visibleLeads(state).map(lead => lead.id));
    const tasks = visibleTasks(state).filter(task => !task.done);
    const calls = visibleLeads(state).flatMap(lead => lead.calls || []);
    return PEOPLE.map(name => {
      const role = Object.values(ROLES).find(item => item.person === name);
      const owned = leads.filter(lead => lead.assignee === name);
      const ownedIds = new Set(owned.map(lead => lead.id));
      return {
        name,
        // From the server when connected; the sample workspace has its own.
        signIn: state.remote ? state.remote.people?.find(person => person.name === name)?.sign_in : SIGN_IN[name],
        title: role?.name || "Team member",
        group: role?.title || "",
        leads: owned.length,
        tasks: tasks.filter(task => task.assignee === name).length,
        calls: calls.filter(call => call.agent === name).length,
        waiting: state.handoffs.filter(item => item.to === name && item.status === "Requested" && ids.has(item.leadId)).length,
        pipeline: state.deals.filter(deal => ownedIds.has(deal.leadId) && !deal.stage.startsWith("Closed")).reduce((sum, deal) => sum + deal.amount, 0),
      };
    });
  }, [state]);

  const unassigned = visibleLeads(state).filter(lead => lead.stage !== "Closed" && (!lead.assignee || lead.assignee === "Unassigned")).length;
  const openTasks = people.reduce((sum, person) => sum + person.tasks, 0);
  const activeLeads = people.reduce((sum, person) => sum + person.leads, 0);

  return (
    <>
      <PageHeader title="Team" description="Who owns what, and what is waiting on them." />
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
