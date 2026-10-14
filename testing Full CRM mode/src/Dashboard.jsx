import { ArrowUpRight, ArrowRight, Phone, CheckCircle, Clock, Users, Handshake, ShieldCheck, Database, HardDrives, GearSix, Plus } from "@phosphor-icons/react";
import { CallActivityChart } from "./CallActivityChart.jsx";
import { ROLES } from "./data.js";
import { capability, personalProfile, visibleLeads, visibleTasks } from "./model.js";
import { useCrm } from "./context.jsx";
import { Badge, Button, Card, Empty, LeadLink, Person, RoundButton, Status, money, PageHeader } from "./ui.jsx";

export function Dashboard() {
  const { state, navigate, dispatch, notify } = useCrm();
  const role = ROLES[state.role];
  const leads = visibleLeads(state);
  const tasks = visibleTasks(state).filter(task => !task.done);
  const leadIds = new Set(leads.map(lead => lead.id));
  const deals = state.deals.filter(deal => leadIds.has(deal.leadId) && !deal.stage.startsWith("Closed"));
  const handoffs = state.handoffs.filter(item => item.status === "Requested" && leadIds.has(item.leadId));
  const active = leads.filter(lead => lead.stage !== "Closed");
  const next = active.find(lead => lead.callback) || active[0];
  const finance = capability(state, "finance");
  const history = state.activities.filter(item => item.leadId && leadIds.has(item.leadId));
  const isClient = state.role === "client";

  if (state.role === "admin")
    return (
      <>
        <PageHeader
          eyebrow="System workspace"
          title="Everything, in its place."
          description="Workspace access, connections, and the services behind your team."
        />
        <div className="metrics-grid">
          {[
            ["Workspace members", "6", Users],
            ["Role presets", "8", ShieldCheck],
            ["Language services", "6", HardDrives],
            ["Connected providers", String(Object.values(state.integrations).filter(Boolean).length), GearSix],
          ].map(([label, value, Icon]) => (
            <Card key={label} className="metric">
              <div className="metric-label">
                <Icon size={20} />
                {label}
              </div>
              <strong>{value}</strong>
              <small>Prototype configuration</small>
            </Card>
          ))}
        </div>
        <div className="two-columns">
          <Card title="Access should be intentional" subtitle="Administration does not grant access to private CRM records.">
            <p className="body-copy">
              Give each person the tools they need, with clear record and field permissions. Business access is a separate capability.
            </p>
            <Button variant="primary" onClick={() => navigate("settings/permissions")}>
              Review role permissions
            </Button>
          </Card>
          <Card title="Server architecture" subtitle="Planned services from the implementation plan.">
            <div className="service-summary">
              {["Rust · Core API", "Python · Skip Tracing & ML", "Go · Scheduling", "C++ · Matching", "C · Media", "JavaScript · Providers"].map(name => (
                <div key={name}>
                  <Database size={16} />
                  <span>{name}</span>
                  <Badge>Planned</Badge>
                </div>
              ))}
            </div>
            <Button onClick={() => navigate("settings/services")}>View service layout</Button>
          </Card>
        </div>
      </>
    );

  return (
    <>
      <PageHeader
        eyebrow={isClient ? "Your shared workspace" : role.title}
        title={isClient ? "A clearer view of your properties." : "Good morning, " + personalProfile(state).name.split(" ")[0] + "."}
        description={
          isClient
            ? "Your approved records, updates, and next steps in one place."
            : tasks.length + " next steps. " + active.length + " active leads. Let's keep things moving."
        }
      >
        <span className="date-label">Thursday, October 15</span>
        {capability(state, "edit") && (
          <Button variant="primary" icon={Plus} onClick={() => navigate("work/leads/new")}>
            New lead
          </Button>
        )}
      </PageHeader>
      <div className="metrics-grid">
        <Metric
          label={isClient ? "Shared properties" : state.role === "researcher" ? "Project leads" : "Active leads"}
          value={isClient ? leads.length : active.length}
          detail={role.scope}
          icon={Users}
          onClick={() => navigate("work/leads")}
        />
        <Metric label="Next steps" value={tasks.length} detail="Assigned and not completed" icon={Clock} onClick={() => navigate("work/tasks")} />
        <Metric
          label={isClient ? "Approved briefs" : state.role === "researcher" ? "Ready to call" : "Open handoffs"}
          value={isClient ? leads.length : state.role === "researcher" ? leads.filter(lead => lead.verdict === "Ready to call").length : handoffs.length}
          detail={isClient ? "Shared by your team" : state.role === "researcher" ? "From the sample checks" : "Waiting for acceptance"}
          icon={Handshake}
          onClick={() => navigate(isClient ? "work/leads" : state.role === "researcher" ? "skip" : "work/handoffs")}
        />
        <Metric
          label={finance ? "Acquisition pipeline" : "Qualified leads"}
          value={finance ? money(deals.reduce((sum, deal) => sum + deal.amount, 0)) : leads.filter(lead => lead.stage === "Qualified").length}
          detail={finance ? deals.length + " active deals" : "Ready for the next conversation"}
          icon={CheckCircle}
          onClick={() => navigate(finance ? "work/deals" : "work/leads")}
        />
      </div>
      <div className="dashboard-main">
        <div className="dashboard-left">
          <Card
            title={isClient ? "Property spotlight" : "A good next conversation"}
            subtitle={isClient ? "An approved property in your shared workspace." : "The context you need, before you pick up the phone."}
            action={<RoundButton label="Open next lead" onClick={() => next && navigate("work/leads/" + next.id)} />}
          >
            {next ? (
              <div className="spotlight">
                <div className="property-image">
                  <img src="/assets/property.jpg" alt="Illustrative exterior of a fictional Florida property" />
                  <span className="image-caption">Illustrative sample photo</span>
                  <Badge tone="good">{isClient ? "Shared with you" : next.verdict}</Badge>
                </div>
                <div className="spotlight-info">
                  <div className="row">
                    <Status value={next.stage} />
                    {!isClient && <span className="muted">{next.source}</span>}
                  </div>
                  <h3>{next.address}</h3>
                  <p>
                    {next.city}, {next.region} {next.zip}
                  </p>
                  <div className="property-facts">
                    <span>{next.beds} beds</span>
                    <span>{next.baths} baths</span>
                    <span>{next.area.toLocaleString()} sq ft</span>
                  </div>
                  <div className="seller-line">
                    <span>Property owner</span>
                    <strong>{next.name}</strong>
                  </div>
                  <p className="motivation">{isClient ? "Property brief and approved updates are ready to review." : next.motivation}</p>
                  <div className="row">
                    <Button
                      variant="primary"
                      icon={isClient ? ArrowUpRight : Phone}
                      onClick={() => navigate(isClient || !capability(state, "call") ? "work/leads/" + next.id : "work/calls/" + next.id)}
                    >
                      {isClient ? "View property" : capability(state, "call") ? "Open call workspace" : "Review lead"}
                    </Button>
                    {!isClient && (
                      <span className="callback-time">
                        <Clock size={15} />
                        {next.callback || "No callback set"}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <Empty>No active leads in this view.</Empty>
            )}
          </Card>
          {!isClient && (
            <Card
              title={state.role === "researcher" ? "Contact quality" : "Conversations, over time"}
              subtitle={
                state.role === "researcher" ? "Ready, unverified, and blocked numbers in your visible records." : "Illustrative call activity · last seven days"
              }
              action={
                <Button onClick={() => navigate(role.pages.includes("reports") ? "reports" : "work/calls")}>
                  {role.pages.includes("reports") ? "View report" : "View calls"} <ArrowUpRight size={15} />
                </Button>
              }
            >
              {state.role === "researcher" ? (
                <div className="quality-list">
                  {["Ready to call", "Unverified", "Do not call", "Possible duplicate"].map(verdict => {
                    const count = leads.filter(lead => lead.verdict === verdict).length;
                    return (
                      <div key={verdict}>
                        <span>{verdict}</span>
                        <meter min="0" max={Math.max(leads.length, 1)} value={count} />
                        <strong>{count}</strong>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <CallActivityChart />
              )}
            </Card>
          )}
          {isClient && (
            <Card title="Approved updates" subtitle="Shared information from your project team.">
              {leads.map(lead => (
                <div className="list-row" key={lead.id}>
                  <div>
                    <LeadLink lead={lead} />
                    <small>Property brief ready for review</small>
                  </div>
                  <Button onClick={() => navigate("work/leads/" + lead.id)}>
                    Open brief <ArrowUpRight size={16} />
                  </Button>
                </div>
              ))}
            </Card>
          )}
        </div>
        <div className="dashboard-right">
          <Card
            title="Your next steps"
            subtitle="A little focus goes a long way."
            action={<RoundButton label="Open tasks" onClick={() => navigate("work/tasks")} />}
          >
            {tasks.length ? (
              <div className="task-preview">
                {tasks.slice(0, 4).map(task => (
                  <div key={task.id}>
                    <button
                      className="task-check"
                      aria-label={"Complete " + task.title}
                      disabled={isClient}
                      onClick={() => {
                        dispatch({ type: "TASK", id: task.id });
                        notify("Task completed");
                      }}
                    >
                      <CheckCircle size={24} weight="light" />
                    </button>
                    <div>
                      <button className="text-button" onClick={() => navigate("work/leads/" + task.leadId)}>
                        {task.title}
                      </button>
                      <small>
                        {task.time} · {task.date === "2026-10-15" ? "Today" : "Tomorrow"}
                      </small>
                    </div>
                    <Status value={task.priority} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="You're all caught up">Nothing waiting in your current scope.</Empty>
            )}
            <Button icon={ArrowRight} onClick={() => navigate("work/tasks")}>
              See all next steps
            </Button>
          </Card>
          {!isClient && (
            <Card title="Team activity" subtitle="The story behind the records.">
              {history.slice(0, 4).map(item => (
                <div className="activity-item" key={item.id}>
                  <span className="activity-icon">
                    <ArrowUpRight size={16} />
                  </span>
                  <div>
                    <p>{item.text}</p>
                    <small>
                      {item.actor} · {item.time}
                    </small>
                  </div>
                </div>
              ))}
              {history.length === 0 && <Empty>No activity in this view.</Empty>}
            </Card>
          )}
          {!isClient && (
            <Card title="Lead stages" subtitle="Every lead has a next destination.">
              <div className="stage-summary">
                {["New", "Contacted", "Interested", "Qualified"].map(stage => (
                  <button key={stage} onClick={() => navigate("work/leads?stage=" + encodeURIComponent(stage))}>
                    <span>{stage}</span>
                    <meter min="0" max={Math.max(leads.length, 1)} value={leads.filter(lead => lead.stage === stage).length} />
                    <strong>{leads.filter(lead => lead.stage === stage).length}</strong>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
      {!isClient && state.role !== "caller" && state.role !== "closer" && (
        <Card title="People, not just numbers" subtitle="A shared view of responsibility." className="team-card">
          <div className="team-people">
            {["Maya Chen", "Alex Rivera", "Ben Carter", "Lena Brooks"].map(name => (
              <div key={name}>
                <Person name={name} />
                <strong>{active.filter(lead => lead.assignee === name).length}</strong>
                <small>active leads</small>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
function Metric({ label, value, detail, icon: Icon, onClick }) {
  return (
    <button className="card metric metric-button" onClick={onClick}>
      <div className="metric-label">
        <span>{label}</span>
        <Icon size={20} weight="light" />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </button>
  );
}
