import { useRef, useState } from "react";
import { PropertyMap } from "./PropertyMap.jsx";
import {
  Phone,
  PhoneDisconnect,
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  Clock,
  Handshake,
  Plus,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Envelope,
  ChatCircle,
  PaperPlaneTilt,
  Paperclip,
} from "@phosphor-icons/react";
import { CALL_OUTCOMES, DEAL_STAGES, PEOPLE, ROLES, TODAY } from "./data.js";
import { callbackLabel, capability, uid, visibleLeads, visibleTasks, visibleThreads } from "./model.js";
import { useCrm } from "./context.jsx";
import { Badge, Select, Button, Card, Empty, Field, LeadLink, Modal, PageHeader, Person, RoundButton, Search, Segmented, Status, money, Breadcrumb } from "./ui.jsx";

export function Calls({ target }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const [chosen, setChosen] = useState(target || "");
  const [activeCall, setActiveCall] = useState(false);
  const [script, setScript] = useState("First conversation");
  const [recording, setRecording] = useState(false);
  const [callNote, setCallNote] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [askingCallback, setAskingCallback] = useState(false);
  const leads = visibleLeads(state).filter(item => item.stage !== "Closed" && item.verdict !== "Do not call" && item.verdict !== "Wrong number");
  const lead = leads.find(item => item.id === chosen) || leads[0];
  if (!capability(state, "call")) return <Empty title="Calling is outside this role">Your workspace only shows the actions available to you.</Empty>;
  function outcome(value) {
    if (!lead) return;
    if (value === "Callback" && !callbackAt) {
      setAskingCallback(true);
      return;
    }
    dispatch({ type: "CALL", leadId: lead.id, outcome: value, callbackAt });
    if (callNote.trim()) dispatch({ type: "NOTE", leadId: lead.id, text: callNote });
    setCallNote("");
    setCallbackAt("");
    setAskingCallback(false);
    setActiveCall(false);
    notify(state.online ? value + " recorded" : "Manual call outcome queued for sync");
    // A live conversation stays on screen for the next step; anything else moves to the next lead.
    if (!["Transfer", "Callback"].includes(value)) setChosen(leads[(leads.findIndex(item => item.id === lead.id) + 1) % leads.length]?.id || "");
  }
  const calls = [...(lead?.calls || [])].reverse();
  return (
    <>
      <PageHeader eyebrow="Outreach workspace" title="One good conversation at a time." description="Your queue, the seller context, and a clear next step." />
      <div className="call-layout">
        <Card title="Your call queue" subtitle={leads.length + " leads in your view"} className="queue-card">
          {leads.map(item => (
            <button
              className={"queue-lead " + (item.id === lead?.id ? "selected" : "")}
              key={item.id}
              onClick={() => {
                setChosen(item.id);
                setActiveCall(false);
              }}
            >
              <strong>{item.name}</strong>
              <small>{item.address}</small>
              <div>
                <Status value={item.stage} />
                <span>{callbackLabel(item.callbackDate, item.callback) || "No time set"}</span>
              </div>
              <div>
                <small className="muted">{item.calls?.length ? item.calls.length + (item.calls.length === 1 ? " call · " : " calls · ") + item.calls.at(-1).outcome : "Not called yet"}</small>
              </div>
            </button>
          ))}
          {!leads.length && <Empty title="No callable leads">Blocked and closed leads are left out.</Empty>}
        </Card>
        <div className="call-main">
          {lead ? (
            <>
              <Card className="call-person">
                <div className="row">
                  <Badge tone="good">Sample phone workspace</Badge>
                  <Status value={lead.stage} />
                </div>
                <h2>{lead.name}</h2>
                <p>
                  {lead.address} · {lead.city}, {lead.region}
                </p>
                <div className="dial-number">{lead.phone}</div>
                <div className="row">
                  <Status value={lead.verdict} />
                  <span className="muted">Review current calling permission before a real call</span>
                </div>
                <p className="body-copy">{lead.motivation}</p>
                <div className="call-actions">
                  <Button
                    variant={activeCall ? "danger-button" : "primary"}
                    icon={activeCall ? PhoneDisconnect : Phone}
                    disabled={!state.online}
                    onClick={() => {
                      setActiveCall(!activeCall);
                      notify(activeCall ? "Demo call ended" : "Demo call started — no real number is dialed");
                    }}
                  >
                    {activeCall ? "End demo call" : "Start demo call"}
                  </Button>
                  <Button onClick={() => navigate("work/leads/" + lead.id)}>
                    Full lead record
                  </Button>
                </div>
                {activeCall && (
                  <div className="call-live" role="status">
                    <span className="status-dot" />
                    Demo call in progress · audio is simulated
                  </div>
                )}
                {!state.online && <p className="notice">Calling needs a connection. You can record a manual outcome below.</p>}
              </Card>
              <PropertyMap rows={[lead]} title="Call property location" compact />
              <Card title="How did the conversation go?" subtitle="Outcomes stay attached to the lead and its phone evidence.">
                <div className="outcome-grid">
                  {CALL_OUTCOMES.map(item => (
                    <Button
                      key={item.label}
                      title={item.help}
                      variant={item.label === "Transfer" ? "peach-button" : item.label === "Do not call" ? "danger-button" : ""}
                      onClick={() => outcome(item.label)}
                    >
                      {item.label} <span className="outcome-code">{item.code}</span>
                    </Button>
                  ))}
                </div>
                {askingCallback && (
                  <div className="callback-picker">
                    <Field label="Call back at" help="The callback is added to the lead and your tasks.">
                      <input aria-label="Call back at" type="datetime-local" min={TODAY + "T00:00"} value={callbackAt} onChange={event => setCallbackAt(event.target.value)} />
                    </Field>
                    <Button variant="primary" disabled={!callbackAt} onClick={() => outcome("Callback")}>
                      Schedule callback
                    </Button>
                    <Button
                      onClick={() => {
                        setAskingCallback(false);
                        setCallbackAt("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
                <Field label="Call note">
                  <textarea value={callNote} onChange={event => setCallNote(event.target.value)} placeholder="The detail you don't want to forget…" />
                </Field>
                <div className="row">
                  <Button icon={Handshake} onClick={() => navigate("work/leads/" + lead.id)}>
                    Qualify & hand off
                  </Button>
                  <label className="check">
                    <input type="checkbox" checked={recording} onChange={event => setRecording(event.target.checked)} />
                    Record demo session
                  </label>
                </div>
                {recording && <small>Recording preview enabled. This prototype does not record microphone audio.</small>}
              </Card>
              <CallHistory calls={calls} />
            </>
          ) : (
            <Empty title="Your queue is clear">Choose another role or add a lead to continue.</Empty>
          )}
        </div>
        <aside>
          <Card title="A little help with the words">
            <Field label="Call script">
              <Select value={script} onChange={event => setScript(event.target.value)}>
                <option>First conversation</option>
                <option>Callback</option>
                <option>Offer follow-up</option>
              </Select>
            </Field>
            <div className="script">
              {script === "First conversation"
                ? "Hi, this is " +
                  ROLES[state.role].person.split(" ")[0] +
                  " from Oak & Palm. I'm reaching out about your property. Is now a good time for a quick conversation?"
                : script === "Callback"
                  ? "Hi, thanks for making time. Last time we spoke about your plans for the property. Has anything changed since then?"
                  : "Hi, I wanted to see if you've had a chance to review the offer. What questions can I help with?"}
            </div>
            <h3>Listen for</h3>
            <ul className="plain-list">
              <li>Their plans and reason for selling</li>
              <li>Property condition and occupancy</li>
              <li>Expected timeline</li>
              <li>The next agreed conversation</li>
            </ul>
          </Card>
          <Card title="Responsibility">
            {lead && <Person name={lead.assignee} />}
            <p className="muted">A handoff changes ownership only when accepted.</p>
          </Card>
        </aside>
      </div>
    </>
  );
}

function callTime(at) {
  return at ? new Date(at + ":00Z").toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) : "";
}
export function CallHistory({ calls }) {
  return (
    <Card title="Call history" subtitle={calls.length ? calls.length + (calls.length === 1 ? " call, newest first" : " calls, newest first") : "Every dialed call is kept here."}>
      {calls.map(item => (
        <div className="call-entry" key={item.id}>
          <Badge tone={["Wrong number", "Do not call"].includes(item.outcome) ? "danger" : ["Transfer", "Callback"].includes(item.outcome) ? "good" : ""}>{item.code}</Badge>
          <div>
            <strong>{item.outcome}</strong>
            <small>
              {callTime(item.at)} · {item.agent}
              {item.scheduled ? " · next call " + callTime(item.scheduled) : ""}
            </small>
          </div>
        </div>
      ))}
      {!calls.length && <Empty title="Not called yet">Outcomes you record appear here with their time and next call.</Empty>}
    </Card>
  );
}

export function Handoffs() {
  const { state, dispatch, navigate, notify } = useCrm();
  const [filter, setFilter] = useState("All");
  const visible = visibleLeads(state);
  const ids = new Set(visible.map(item => item.id));
  const items = state.handoffs.filter(item => ids.has(item.leadId) && (filter === "All" || item.status === filter));
  return (
    <>
      <PageHeader title="Good handoffs keep the context." description="Know who sent it, who accepts it, and what happens next." />
      <div className="filter-bar">
        <Segmented label="Handoff status" value={filter} onChange={setFilter} options={["All", "Requested", "Accepted", "Declined"]} />
        <span className="result-count">{items.length} handoffs</span>
      </div>
      <div className="handoff-grid">
        {items.map(item => {
          const lead = visible.find(lead => lead.id === item.leadId);
          const canAccept = capability(state, "accept") && (["owner", "solo", "manager"].includes(state.role) || item.to === ROLES[state.role].person);
          return (
            <Card key={item.id} title={lead.name} subtitle={lead.address} action={<Status value={item.status} />}>
              <div className="handoff-people">
                <Person name={item.from} />
                <ArrowRight size={20} />
                <Person name={item.to} />
              </div>
              <p className="body-copy">{item.note}</p>
              <small>{item.at} · Ownership changes on acceptance</small>
              <div className="row">
                {item.status === "Requested" && canAccept && (
                  <>
                    <Button
                      variant="primary"
                      icon={Handshake}
                      disabled={!state.online}
                      onClick={() => {
                        dispatch({ type: "ACCEPT", id: item.id });
                        notify("Handoff accepted. A deal is ready.");
                      }}
                    >
                      Accept handoff
                    </Button>
                    <Button
                      disabled={!state.online}
                      onClick={() => {
                        dispatch({ type: "ACCEPT", id: item.id, decline: true });
                        notify("Handoff declined");
                      }}
                    >
                      Decline
                    </Button>
                  </>
                )}
                <Button onClick={() => navigate("work/leads/" + lead.id)}>
                  Open lead <ArrowUpRight size={16} />
                </Button>
              </div>
              {!state.online && item.status === "Requested" && <p className="muted">Acceptance requires a live connection.</p>}
            </Card>
          );
        })}
      </div>
      {!items.length && (
        <Card>
          <Empty
            title={filter === "Requested" ? "No handoffs waiting" : "No handoffs in this view"}
            action={<Button onClick={() => navigate("work/leads")}>Review leads</Button>}
          >
            Request a handoff from a lead's record when the next person has the context they need.
          </Empty>
        </Card>
      )}
    </>
  );
}

export function Deals({ id }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const [view, setView] = useState("Pipeline");
  const [drag, setDrag] = useState(null);
  const justDragged = useRef(false);
  const leads = visibleLeads(state);
  const ids = new Set(leads.map(item => item.id));
  const deals = state.deals.filter(item => ids.has(item.leadId));
  // Pointer-based drag so cards move the same way in browsers and the desktop webview, which swallows native drag and drop.
  const startDrag = (event, deal, label) => {
    if (event.button !== 0 || event.target.closest("select")) return;
    const card = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const offset = { x: event.clientX - card.left, y: event.clientY - card.top };
    let active = false;
    let over = null;
    const stageAt = (x, y) => document.elementFromPoint(x, y)?.closest("[data-stage]")?.dataset.stage ?? null;
    const move = e => {
      if (!active && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      active = true;
      over = stageAt(e.clientX, e.clientY);
      setDrag({ id: deal.id, label, amount: deal.amount, width: card.width, x: e.clientX - offset.x, y: e.clientY - offset.y, over });
    };
    const finish = e => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setDrag(null);
      if (!active) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      const target = e.type === "pointercancel" ? null : over;
      if (target && target !== deal.stage) {
        dispatch({ type: "DEAL", id: deal.id, change: { stage: target } });
        notify("Deal moved to " + target);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  if (!capability(state, "finance")) return <Empty title="Deal financials are outside this role">Your approved records are available in Leads.</Empty>;
  if (id) {
    const deal = deals.find(item => item.id === id);
    if (!deal) return <Empty title="This deal is outside your view" />;
    const lead = leads.find(item => item.id === deal.leadId);
    return (
      <>
        <Breadcrumb items={[{ label: "Deals", path: "work/deals" }, { label: lead.address }]} />
        <PageHeader title={lead.address} description={"Acquisition · " + lead.name}>
          <Button onClick={() => navigate("work/leads/" + lead.id)}>
            Open lead <ArrowUpRight size={17} />
          </Button>
        </PageHeader>
        <div className="two-columns">
          <Card title="The deal, at a glance">
            <div className="deal-amount">{money(deal.amount)}</div>
            <div className="form-grid">
              <Field label="Deal stage">
                <Select
                  value={deal.stage}
                  onChange={event => {
                    dispatch({ type: "DEAL", id, change: { stage: event.target.value } });
                    notify("Deal stage updated");
                  }}
                >
                  {DEAL_STAGES.map(stage => (
                    <option key={stage}>{stage}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Target close date">
                <input type="date" value={deal.closeDate} onChange={event => dispatch({ type: "DEAL", id, change: { closeDate: event.target.value } })} />
              </Field>
              <Field label="Offer amount">
                <input
                  type="number"
                  min="0"
                  value={deal.amount}
                  onChange={event => dispatch({ type: "DEAL", id, change: { amount: Math.max(0, Number(event.target.value)) } })}
                />
              </Field>
              <Field label="Expected fee">
                <input
                  type="number"
                  min="0"
                  value={deal.fee}
                  onChange={event => dispatch({ type: "DEAL", id, change: { fee: Math.max(0, Number(event.target.value)) } })}
                />
              </Field>
            </div>
            <p className="muted">These are manually recorded sample amounts, separate from estimated property value.</p>
          </Card>
          <Card title="Context & next steps">
            <Person name={lead.assignee} />
            <p className="body-copy">{lead.motivation}</p>
            {visibleTasks(state)
              .filter(task => task.leadId === lead.id)
              .map(task => (
                <div className="compact-task" key={task.id}>
                  <Clock size={18} />
                  <div>
                    <strong>{task.title}</strong>
                    <small>
                      {task.date} · {task.time}
                    </small>
                  </div>
                </div>
              ))}
            <Button onClick={() => navigate("work/tasks/new?lead=" + lead.id)}>Add a next step</Button>
            <Button onClick={() => navigate("work/leads/" + lead.id)}>Open documents</Button>
          </Card>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader title="From conversation to closing." description="A separate deal for every transaction, connected to its lead and property." />
      <div className="pipeline-summary">
        <div>
          <small>Active pipeline</small>
          <strong>{money(deals.filter(item => !item.stage.startsWith("Closed")).reduce((sum, item) => sum + item.amount, 0))}</strong>
        </div>
        <div>
          <small>Expected fees</small>
          <strong>{money(deals.reduce((sum, item) => sum + item.fee, 0))}</strong>
        </div>
        <div>
          <small>Under contract</small>
          <strong>{deals.filter(item => item.stage === "Under contract").length}</strong>
        </div>
        <Segmented label="Deal view" value={view} options={["Pipeline", "List"]} onChange={setView} />
      </div>
      {view === "Pipeline" ? (
        <div className="kanban deal-board">
          {DEAL_STAGES.map(stage => (
            <section
              key={stage}
              className={"kanban-column" + (drag?.over === stage ? " drop-target" : "")}
              data-stage={stage}
            >
              <header>
                <span>{stage}</span>
                <Badge>{deals.filter(item => item.stage === stage).length}</Badge>
              </header>
              {deals
                .filter(item => item.stage === stage)
                .map(deal => {
                  const lead = leads.find(item => item.id === deal.leadId);
                  return (
                    <article
                      key={deal.id}
                      className={"kanban-card" + (drag?.id === deal.id ? " dragging" : "")}
                      onPointerDown={event => startDrag(event, deal, lead.address)}
                    >
                      <button
                        onClick={() => {
                          if (!justDragged.current) navigate("work/deals/" + deal.id);
                        }}
                      >
                        <strong>{lead.address}</strong>
                        <span>{lead.name}</span>
                      </button>
                      <div className="deal-card-amount">{money(deal.amount)}</div>
                      <small>
                        <CalendarBlank size={13} /> {deal.closeDate}
                      </small>
                      <Person name={lead.assignee} />
                      <Select
                        aria-label={"Move deal for " + lead.name}
                        value={deal.stage}
                        onChange={event => dispatch({ type: "DEAL", id: deal.id, change: { stage: event.target.value } })}
                      >
                        {DEAL_STAGES.map(item => (
                          <option key={item}>{item}</option>
                        ))}
                      </Select>
                    </article>
                  );
                })}
              {!deals.some(item => item.stage === stage) && <p className="column-empty">No deals here</p>}
            </section>
          ))}
          {drag && (
            <div className="kanban-ghost" style={{ width: drag.width, transform: `translate(${drag.x}px, ${drag.y}px)` }}>
              <strong>{drag.label}</strong>
              <div className="deal-card-amount">{money(drag.amount)}</div>
            </div>
          )}
        </div>
      ) : (
        <Card className="table-card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Stage</th>
                  <th>Offer amount</th>
                  <th>Expected fee</th>
                  <th>Target close</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deals.map(deal => {
                  const lead = leads.find(item => item.id === deal.leadId);
                  return (
                    <tr key={deal.id}>
                      <td>
                        <LeadLink lead={lead} />
                      </td>
                      <td>
                        <Status value={deal.stage} />
                      </td>
                      <td>{money(deal.amount)}</td>
                      <td>{money(deal.fee)}</td>
                      <td>{deal.closeDate}</td>
                      <td>
                        <RoundButton label={"Open deal for " + lead.name} onClick={() => navigate("work/deals/" + deal.id)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

export function Tasks({ create = false }) {
  const { state, dispatch, navigate, notify, route } = useCrm();
  const [filter, setFilter] = useState("Open");
  const [search, setSearch] = useState("");
  const mine = new URLSearchParams(route.split("?")[1]).get("mine") === "1";
  const leads = visibleLeads(state);
  const tasks = visibleTasks(state).filter(
    task =>
      (!mine || task.assignee === ROLES[state.role].person) &&
      (filter === "All" || task.done === (filter === "Completed")) &&
      task.title.toLowerCase().includes(search.toLowerCase()),
  );
  const editable = capability(state, "edit") || capability(state, "review");
  if (create && editable)
    return (
      <>
        <Breadcrumb items={[{ label: "Tasks", path: "work/tasks" }, { label: "New task" }]} />
        <PageHeader title="Make the next step explicit." />
        <form
          className="card creation-form"
          onSubmit={event => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            dispatch({
              type: "TASK",
              task: {
                title: String(data.get("title")).trim(),
                leadId: String(data.get("lead")),
                assignee: String(data.get("assignee")),
                date: String(data.get("date")),
                time: String(data.get("time")),
                priority: String(data.get("priority")),
                type: String(data.get("type")),
              },
            });
            notify("Task created");
            navigate("work/tasks");
          }}
        >
          <div className="form-grid">
            <Field label="Task">
              <input name="title" required placeholder="What needs to happen?" />
            </Field>
            <Field label="Related lead">
              <Select name="lead" defaultValue={new URLSearchParams(route.split("?")[1]).get("lead") || leads[0]?.id}>
                {leads.map(lead => (
                  <option key={lead.id} value={lead.id}>
                    {lead.name} · {lead.address}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Responsible person">
              <Select name="assignee" defaultValue={ROLES[state.role].person}>
                {[...new Set([ROLES[state.role].person, ...PEOPLE])].map(name => (
                  <option key={name}>{name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Task type">
              <Select name="type">
                {["Callback", "Appointment", "Offer", "Data review", "Document"].map(type => (
                  <option key={type}>{type}</option>
                ))}
              </Select>
            </Field>
            <Field label="Due date">
              <input name="date" type="date" defaultValue={TODAY} required />
            </Field>
            <Field label="Time">
              <input name="time" type="time" defaultValue="10:30" />
            </Field>
            <Field label="Priority">
              <Select name="priority">
                <option>Normal</option>
                <option>High</option>
              </Select>
            </Field>
          </div>
          <div className="form-actions">
            <Button onClick={() => navigate("work/tasks")}>Cancel</Button>
            <button className="button primary" type="submit" disabled={!leads.length}>
              <Plus size={17} />
              Create task
            </button>
          </div>
        </form>
      </>
    );
  return (
    <>
      <PageHeader
        title={state.role === "client" ? "Your shared next steps" : "A place for every next step."}
        description={"All times shown in " + state.settings.timezone + "."}
      >
        {editable && (
          <Button variant="primary" icon={Plus} onClick={() => navigate("work/tasks/new")}>
            New task
          </Button>
        )}
        {ROLES[state.role].pages.includes("calendar") && (
          <Button icon={CalendarBlank} onClick={() => navigate("work/calendar")}>
            Calendar
          </Button>
        )}
      </PageHeader>
      <div className="filter-bar">
        <Search value={search} onChange={setSearch} placeholder="Search tasks" />
        <Select
          aria-label="Task scope"
          value={mine ? "mine" : "all"}
          onChange={event => navigate(event.target.value === "mine" ? "work/tasks?mine=1" : "work/tasks")}
        >
          <option value="all">All visible tasks</option>
          <option value="mine">My tasks</option>
        </Select>
        <Segmented label="Task status" value={filter} onChange={setFilter} options={["Open", "Completed", "All"]} />
        <span className="result-count">{tasks.length} tasks</span>
      </div>
      <Card className="table-card">
        <div className="task-list">
          {tasks.map(task => {
            const lead = leads.find(item => item.id === task.leadId);
            return (
              <div className={"task-list-row " + (task.done ? "completed" : "")} key={task.id}>
                <button
                  disabled={!editable}
                  className="task-check"
                  aria-label={(task.done ? "Reopen " : "Complete ") + task.title}
                  onClick={() => {
                    dispatch({ type: "TASK", id: task.id });
                    notify(task.done ? "Task reopened" : "Task completed");
                  }}
                >
                  <CheckCircle size={26} weight={task.done ? "fill" : "light"} />
                </button>
                <div>
                  <strong>{task.title}</strong>
                  <button className="text-button muted" onClick={() => navigate("work/leads/" + lead.id)}>
                    {lead.name} · {lead.address}
                  </button>
                </div>
                <Badge>{task.type}</Badge>
                <span className="task-due">
                  {task.date === TODAY ? "Today" : task.date}
                  <small>{task.time}</small>
                </span>
                <Status value={task.priority} />
                <Person name={task.assignee} />
              </div>
            );
          })}
        </div>
        {!tasks.length && <Empty title="Nothing waiting here">Try another status or add a next step.</Empty>}
      </Card>
    </>
  );
}

export function Calendar() {
  const { state, dispatch, navigate } = useCrm();
  const [month, setMonth] = useState(9);
  const [year, setYear] = useState(2026);
  const [selected, setSelected] = useState(TODAY);
  const tasks = visibleTasks(state);
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, index) => new Date(Date.UTC(year, month, index - offset + 1)));
  const iso = date => date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0");
  function move(delta) {
    const date = new Date(Date.UTC(year, month + delta, 1));
    setMonth(date.getUTCMonth());
    setYear(date.getUTCFullYear());
  }
  return (
    <>
      <PageHeader title="A little room to plan ahead." description={"Appointments and next steps · " + state.settings.timezone}>
        <Button
          onClick={() => {
            setMonth(9);
            setYear(2026);
            setSelected(TODAY);
          }}
        >
          Today
        </Button>
        {capability(state, "edit") && (
          <Button variant="primary" icon={Plus} onClick={() => navigate("work/tasks/new")}>
            New task
          </Button>
        )}
      </PageHeader>
      <div className="calendar-layout">
        <Card className="calendar-card">
          <header>
            <h2>{first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</h2>
            <div className="row">
              <RoundButton label="Previous month" icon={CaretLeft} onClick={() => move(-1)} />
              <RoundButton label="Next month" icon={CaretRight} onClick={() => move(1)} />
            </div>
          </header>
          <div className="calendar-week">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {cells.map(date => {
              const value = iso(date);
              const found = tasks.filter(task => task.date === value && !task.done);
              return (
                <button
                  key={value}
                  className={
                    "calendar-day " +
                    (date.getUTCMonth() !== month ? "outside " : "") +
                    (value === selected ? "selected " : "") +
                    (value === TODAY ? "today" : "")
                  }
                  aria-label={value + ", " + found.length + " tasks"}
                  aria-pressed={value === selected}
                  onClick={() => setSelected(value)}
                >
                  <span>{date.getUTCDate()}</span>
                  {found.slice(0, 2).map(task => (
                    <small key={task.id}>
                      {task.time} {task.title}
                    </small>
                  ))}
                  {found.length > 2 && <small>+{found.length - 2} more</small>}
                </button>
              );
            })}
          </div>
        </Card>
        <Card title={selected === TODAY ? "Today, October 15" : selected} subtitle="The next steps on this day.">
          {tasks
            .filter(task => task.date === selected)
            .map(task => (
              <div className="calendar-agenda" key={task.id}>
                <span>{task.time}</span>
                <strong>{task.title}</strong>
                <Person name={task.assignee} />
                <Button disabled={!capability(state, "edit") && !capability(state, "review")} onClick={() => dispatch({ type: "TASK", id: task.id })}>
                  {task.done ? "Reopen" : "Complete"}
                </Button>
              </div>
            ))}
          {!tasks.some(task => task.date === selected) && <Empty title="A little breathing room">No scheduled next steps on this day.</Empty>}
        </Card>
      </div>
    </>
  );
}

export function Inbox() {
  const { state, dispatch, navigate, notify, route } = useCrm();
  const [channel, setChannel] = useState("All");
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [newLeadId, setNewLeadId] = useState("");
  const [newChannel, setNewChannel] = useState("SMS");
  const leads = visibleLeads(state);

  const threads = visibleThreads(state).filter(thread => channel === "All" || thread.channel === channel);
  const requested = new URLSearchParams(route.split("?")[1]).get("lead");
  const thread = threads.find(item => item.id === selected) || threads.find(item => item.leadId === requested) || threads[0];
  const lead = leads.find(item => item.id === thread?.leadId);
  const canMessage = capability(state, "message") || capability(state, "publicComment");
  return (
    <>
      <PageHeader
        title={state.role === "client" ? "Conversations with your team." : "Every conversation stays connected."}
        description="Email, SMS, and team context beside the record they belong to."
      >
        {canMessage && (
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => {
              setNewLeadId(requested || leads[0]?.id || "");
              setNewChannel(state.role === "client" ? "Partner" : "SMS");
              setNewConversation(true);
            }}
          >
            New conversation
          </Button>
        )}
      </PageHeader>
      <div className="inbox-layout">
        <Card className="thread-list">
          <Segmented
            label="Conversation channel"
            value={channel}
            onChange={value => {
              setChannel(value);
              setSelected("");
            }}
            options={state.role === "client" ? ["All", "Partner"] : ["All", "SMS", "Email", "Team", "Partner"]}
          />
          {threads.map(item => {
            const person = leads.find(lead => lead.id === item.leadId);
            const Icon = item.channel === "Email" ? Envelope : ChatCircle;
            return (
              <button
                key={item.id}
                className={"thread " + (thread?.id === item.id ? "selected" : "")}
                onClick={() => {
                  setSelected(item.id);
                  dispatch({ type: "MARK_READ", id: item.id });
                }}
              >
                <div>
                  <Icon size={19} />
                  <strong>{person.name}</strong>
                  {item.unread && <Badge tone="peach">New</Badge>}
                </div>
                <p>{item.preview}</p>
                <small>
                  {item.channel} · {person.address}
                </small>
              </button>
            );
          })}
          {!threads.length && <Empty title="No conversations here">Start a conversation from a visible lead.</Empty>}
        </Card>
        <Card className="conversation">
          {thread && lead ? (
            <>
              <header>
                <div>
                  <h2>{lead.name}</h2>
                  <small>
                    {thread.channel} · {lead.address}
                  </small>
                </div>
                <RoundButton label="Open conversation lead" onClick={() => navigate("work/leads/" + lead.id)} />
              </header>
              <div className="message-history">
                {thread.messages.map((message, index) => (
                  <div key={index} className={"message " + (message.incoming ? "incoming" : "outgoing")}>
                    <small>{message.from}</small>
                    <p>{message.text}</p>
                    <span>
                      {message.at}
                      {message.draft && " · Not sent"}
                    </span>
                  </div>
                ))}
              </div>
              {canMessage && (
                <form
                  className="composer"
                  onSubmit={event => {
                    event.preventDefault();
                    dispatch({ type: "MESSAGE", id: thread.id, text: draft + (attachment ? "\nAttachment preview: " + attachment : "") });
                    setDraft("");
                    setAttachment("");
                    notify(state.online ? "Demo message added — nothing was sent externally" : "Communication draft saved offline");
                  }}
                >
                  <textarea
                    aria-label="Message text"
                    value={draft}
                    onChange={event => setDraft(event.target.value)}
                    placeholder={state.online ? "Write a message…" : "Write an offline draft…"}
                    required
                  />
                  <div>
                    <label className="attachment-button">
                      <Paperclip size={18} />
                      <span>{attachment || "Attach file"}</span>
                      <input
                        type="file"
                        onChange={event => {
                          const file = event.target.files?.[0];
                          if (file) setAttachment(file.name);
                        }}
                      />
                    </label>
                    <button className="button primary" type="submit" disabled={!draft.trim()}>
                      <PaperPlaneTilt size={17} />
                      {state.online ? "Send demo message" : "Save draft"}
                    </button>
                  </div>
                  <small>Prototype conversation · no real email or SMS is sent</small>
                </form>
              )}
            </>
          ) : (
            <Empty title="A conversation belongs here">Choose a thread or start a new one.</Empty>
          )}
        </Card>
      </div>
      {newConversation && (
        <Modal title="Start with a lead." onClose={() => setNewConversation(false)}>
          <form
            onSubmit={event => {
              event.preventDefault();
              const id = uid();
              dispatch({
                type: "NEW_THREAD",
                thread: {
                  id,
                  leadId: newLeadId,
                  channel: state.role === "client" ? "Partner" : newChannel,
                  shared: state.role === "client" || newChannel === "Partner",
                  preview: "New conversation",
                  unread: false,
                  messages: [],
                },
              });
              setSelected(id);
              setChannel("All");
              setNewConversation(false);
            }}
          >
            <Field label="Related lead">
              <Select value={newLeadId} onChange={event => setNewLeadId(event.target.value)}>
                {leads.map(lead => (
                  <option key={lead.id} value={lead.id}>
                    {lead.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Channel">
              <Select value={newChannel} onChange={event => setNewChannel(event.target.value)}>
                {state.role !== "client" && (
                  <>
                    <option>SMS</option>
                    <option>Email</option>
                    <option>Team</option>
                  </>
                )}
                <option>Partner</option>
              </Select>
            </Field>
            <button type="submit" className="button primary" disabled={!newLeadId}>
              Open conversation
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
