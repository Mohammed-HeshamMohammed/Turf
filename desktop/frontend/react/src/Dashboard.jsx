import { ArrowUpRight, ChatCircle, Phone, CheckCircle, Clock, Users, Handshake, ShieldCheck, Database, HardDrives, GearSix, Plus } from "@phosphor-icons/react";
import { Suspense, lazy } from "react";
import { ROLES, TODAY } from "./data.js";
import { callbackLabel, capability, personalProfile, visibleLeads, visibleTasks, visibleThreads } from "./model.js";
import { useCrm } from "./context.jsx";
import { Badge, Button, Card, Empty, LeadLink, RoundButton, Status, money, PageHeader, propertyFacts } from "./ui.jsx";

// The chart library is the largest dependency, so the dashboard paints first and the chart follows.
const CallActivityChart = lazy(() => import("./CallActivityChart.jsx").then(module => ({ default: module.CallActivityChart })));

export function Dashboard() {
  const { state, navigate } = useCrm();
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
  const leadById = Object.fromEntries(leads.map(lead => [lead.id, lead]));
  const upcoming = tasks
    .filter(task => task.date && task.date > TODAY)
    .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")))
    .slice(0, 4);
  const closing = [...deals].sort((a, b) => (a.closeDate || "").localeCompare(b.closeDate || "")).slice(0, 4);

  if (state.role === "admin")
    return (
      <>
        <PageHeader title="Overview" description="Access, connections and services." />
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
        title={isClient ? "Your properties" : "Good morning, " + personalProfile(state).name.split(" ")[0]}
        description={
          isClient ? "Your approved records, updates, and next steps in one place." : active.length + " active leads · " + tasks.length + " open next steps"
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
          <NeedsToday />
          <Card
            title={isClient ? "Property spotlight" : "A good next conversation"}
            subtitle={isClient ? "An approved property in your shared workspace." : "The context you need, before you pick up the phone."}
            action={<RoundButton label="Open next lead" onClick={() => next && navigate("work/leads/" + next.id)} />}
          >
            {next ? (
              <div className="spotlight">
                <div className="property-image">
                  <img src="/assets/property.jpg" alt="Illustrative exterior of a fictional Florida property" />
                  <span className="image-caption demo-note">Illustrative sample photo</span>
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
                    {propertyFacts(next).map(fact => (
                      <span key={fact}>{fact}</span>
                    ))}
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
                        {callbackLabel(next.callbackDate, next.callback) || "No callback set"}
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
                <Suspense fallback={<div className="chart-placeholder" aria-busy="true" />}>
                  <CallActivityChart />
                </Suspense>
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
            <Card
              title="Coming up"
              subtitle="Next steps after today."
              action={
                <Button onClick={() => navigate("work/tasks")}>
                  All tasks <ArrowUpRight size={15} />
                </Button>
              }
            >
              {upcoming.map(task => (
                <div className="list-row" key={task.id}>
                  <div>
                    <strong>{task.title}</strong>
                    <small>
                      {task.date}
                      {task.time ? " · " + task.time : ""}
                      {leadById[task.leadId] ? " · " + leadById[task.leadId].name : ""}
                    </small>
                  </div>
                  {leadById[task.leadId] && (
                    <Button onClick={() => navigate("work/leads/" + task.leadId)}>
                      Open <ArrowUpRight size={16} />
                    </Button>
                  )}
                </div>
              ))}
              {upcoming.length === 0 && <Empty>Nothing scheduled after today.</Empty>}
            </Card>
          )}
          {!isClient && role.pages.includes("deals") && (
            <Card
              title="Closing soonest"
              subtitle={deals.length + " open " + (deals.length === 1 ? "deal" : "deals")}
              action={
                <Button onClick={() => navigate("work/deals")}>
                  All deals <ArrowUpRight size={15} />
                </Button>
              }
            >
              {closing.map(deal => (
                <div className="list-row" key={deal.id}>
                  <div>
                    <strong>{leadById[deal.leadId]?.address}</strong>
                    <small>
                      {deal.stage} · {money(deal.amount)} · closes {deal.closeDate}
                    </small>
                  </div>
                  <Button onClick={() => navigate("work/leads/" + deal.leadId)}>
                    Open <ArrowUpRight size={16} />
                  </Button>
                </div>
              ))}
              {closing.length === 0 && <Empty>No open deals in this view.</Empty>}
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
    </>
  );
}
/**
 * Everything that is waiting on the person today, in time order, in one place: tasks that are due, callbacks people are
 * expecting, handoffs to accept and unread messages. Each row has the one action that deals with it.
 */
function NeedsToday() {
  const { state, navigate, dispatch, notify } = useCrm();
  const role = ROLES[state.role];
  const me = role.person;
  const client = state.role === "client";
  const leads = visibleLeads(state);
  const byId = Object.fromEntries(leads.map(lead => [lead.id, lead]));
  const due = visibleTasks(state).filter(task => !task.done && task.date && task.date <= TODAY);
  const items = [
    ...due.map(task => ({
      key: "task-" + task.id,
      at: (task.date < TODAY ? "0" : "1") + (task.time || ""),
      icon: CheckCircle,
      title: task.title,
      detail: (task.date < TODAY ? "Overdue · " : "") + (task.time || "Today") + (byId[task.leadId] ? " · " + byId[task.leadId].name : ""),
      complete: client
        ? null
        : () => {
            dispatch({ type: "TASK", id: task.id });
            notify("Task completed");
          },
      action: byId[task.leadId] ? { label: "Open", go: "work/leads/" + task.leadId } : null,
    })),
    // A callback with its own task is already listed above.
    ...leads
      .filter(lead => lead.callback && lead.callbackDate && lead.callbackDate <= TODAY && lead.stage !== "Closed")
      .filter(lead => !due.some(task => task.leadId === lead.id && task.type === "Callback"))
      .map(lead => ({
        key: "call-" + lead.id,
        at: (lead.callbackDate < TODAY ? "0" : "1") + lead.callback,
        icon: Phone,
        title: "Call " + lead.name,
        detail: (lead.callbackDate < TODAY ? "Missed callback · " : "Callback at ") + lead.callback + " · " + lead.address,
        action: capability(state, "call") ? { label: "Call", go: "work/calls/" + lead.id, primary: true } : { label: "Open", go: "work/leads/" + lead.id },
      })),
    ...(capability(state, "accept")
      ? state.handoffs
          .filter(item => item.status === "Requested" && byId[item.leadId] && (item.to === me || ["owner", "solo", "manager"].includes(state.role)))
          .map(item => ({
            key: "handoff-" + item.id,
            at: "2",
            icon: Handshake,
            title: "Handoff waiting: " + byId[item.leadId].name,
            detail: "From " + item.from + " to " + item.to,
            action: { label: "Review", go: "work/handoffs" },
          }))
      : []),
    ...(role.pages.includes("inbox")
      ? visibleThreads(state)
          .filter(thread => thread.unread)
          .map(thread => ({
            key: "thread-" + thread.id,
            at: "3",
            icon: ChatCircle,
            title: "Reply to " + (byId[thread.leadId]?.name || thread.phone),
            detail: thread.channel + " · " + thread.preview,
            action: { label: "Reply", go: "work/inbox?thread=" + thread.id },
          }))
      : []),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <Card title="Needs you today" subtitle={items.length ? items.length + (items.length === 1 ? " thing is" : " things are") + " waiting on you" : undefined}>
      {items.map(item => {
        const Icon = item.icon;
        return (
          <div className="today-row" key={item.key}>
            {item.complete ? (
              <button type="button" className="task-check" aria-label={"Complete " + item.title} onClick={item.complete}>
                <CheckCircle size={22} weight="light" />
              </button>
            ) : (
              <span className="today-icon">
                <Icon size={18} />
              </span>
            )}
            <div>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </div>
            {item.action && (
              <Button variant={item.action.primary ? "primary" : ""} onClick={() => navigate(item.action.go)}>
                {item.action.label}
              </Button>
            )}
          </div>
        );
      })}
      {!items.length && <Empty title="You're all caught up">Nothing is due today. New tasks, callbacks and messages show up here.</Empty>}
    </Card>
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
