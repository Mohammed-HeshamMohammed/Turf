import { useState } from "react";
import {
  Clock,
  CloudArrowUp,
  Database,
  DownloadSimple,
  Envelope,
  FilePdf,
  GearSix,
  HardDrives,
  LockKey,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { capability, visibleLeads, visibleTasks } from "./model.js";
import { useCrm } from "./context.jsx";
import { Badge, Select, Button, Card, Empty, Field, Modal, PageHeader, Person, Segmented, DataTable, Status, downloadCsv, money, useTableView } from "./ui.jsx";

export function Reports() {
  const { state, dispatch, notify } = useCrm();
  const [range, setRange] = useState("This month");
  const [schedule, setSchedule] = useState(false);
  const leads = visibleLeads(state);
  const ids = new Set(leads.map(lead => lead.id));
  const deals = state.deals.filter(item => ids.has(item.leadId));
  const finance = capability(state, "finance");
  const client = state.role === "client";
  const sources = [...new Set(leads.map(lead => (client ? lead.city : lead.source)))];
  const rows = sources.map(source => {
    const found = leads.filter(lead => (client ? lead.city : lead.source) === source);
    return {
      source,
      count: found.length,
      ready: found.filter(lead => lead.verdict === "Ready to call").length,
      qualified: found.filter(lead => lead.stage === "Qualified").length,
      deals: deals.filter(deal => found.some(lead => lead.id === deal.leadId)).length,
    };
  });
  const table = useTableView(
    rows,
    {
      source: { value: row => row.source },
      count: { value: row => row.count },
      ready: { value: row => row.ready },
      qualified: { value: row => row.qualified },
      deals: { value: row => row.deals },
      share: { value: row => row.count },
    },
    "reports",
  );
  return (
    <>
      <PageHeader title="Reports" description="Based only on the records you can see.">
        <Button icon={FilePdf} onClick={() => window.print()}>
          Print / save PDF
        </Button>
        {finance && (
          <Button variant="primary" icon={Clock} onClick={() => setSchedule(true)}>
            Schedule report
          </Button>
        )}
      </PageHeader>
      <div className="filter-bar">
        <Segmented label="Report period" value={range} onChange={setRange} options={["This week", "This month", "All time"]} />
        <Badge>{range} · layout preview</Badge>
        <span className="muted">Totals show the current record snapshot.</span>
      </div>
      <div className="metrics-grid">
        {[
          [client ? "Shared properties" : "Visible leads", leads.length],
          ["Qualified", leads.filter(lead => lead.stage === "Qualified").length],
          ["Open next steps", visibleTasks(state).filter(task => !task.done).length],
          [
            finance ? "Recorded pipeline" : "Completed next steps",
            finance ? money(deals.reduce((sum, item) => sum + item.amount, 0)) : visibleTasks(state).filter(task => task.done).length,
          ],
        ].map(([label, value]) => (
          <Card className="metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{ROLES[state.role].scope}</small>
          </Card>
        ))}
      </div>
      <Card
        title={client ? "Shared property locations" : "Source effectiveness"}
        subtitle={client ? "Only approved shared records are included." : "Which sources are producing the next conversation?"}
        action={
          capability(state, "export") && (
            <Button
              icon={DownloadSimple}
              onClick={() => {
                downloadCsv("callerwhale-report.csv", [
                  [client ? "Location" : "Source", "Visible leads", "Ready", "Qualified", ...(finance ? ["Deals"] : [])],
                  ...rows.map(row => [row.source, row.count, row.ready, row.qualified, ...(finance ? [row.deals] : [])]),
                ]);
                notify("Scoped report exported");
              }}
            >
              Export CSV
            </Button>
          )
        }
      >
        <DataTable
          view={table}
          rowKey={row => row.source}
          columns={[
            { id: "source", label: client ? "Location" : "Source", cell: row => <strong>{row.source}</strong> },
            { id: "count", label: "Visible leads", cell: row => row.count },
            ...(!client ? [{ id: "ready", label: "Ready to call", cell: row => row.ready }] : []),
            { id: "qualified", label: "Qualified", cell: row => row.qualified },
            ...(finance ? [{ id: "deals", label: "Deals", cell: row => row.deals }] : []),
            {
              id: "share",
              label: "Share of records",
              cell: row => (
                <div className="report-meter">
                  <meter min="0" max={Math.max(leads.length, 1)} value={row.count} />
                  <span>{Math.round((row.count / Math.max(leads.length, 1)) * 100)}%</span>
                </div>
              ),
            },
          ]}
        />
      </Card>
      <div className="two-columns">
        <Card title="Lead progression" subtitle="Current record stages in your view.">
          <div className="quality-list">
            {["New", "Contacted", "Interested", "Qualified", "Closed"].map(stage => (
              <div key={stage}>
                <span>{stage}</span>
                <meter min="0" max={Math.max(leads.length, 1)} value={leads.filter(lead => lead.stage === stage).length} />
                <strong>{leads.filter(lead => lead.stage === stage).length}</strong>
              </div>
            ))}
          </div>
        </Card>
        <Card
          title={finance ? "Scheduled reports" : "What this report includes"}
          subtitle={finance ? "Delivery schedules saved in the preview." : "Your role controls records and fields."}
        >
          {finance ? (
            <>
              {state.reportSchedules.map((item, index) => (
                <div className="list-row" key={index}>
                  <div>
                    <strong>
                      {item.frequency} · {item.email}
                    </strong>
                    <small>Demo schedule · no email is sent</small>
                  </div>
                  <Badge tone="good">Saved</Badge>
                </div>
              ))}
              {!state.reportSchedules.length && (
                <Empty title="A report, right on time" action={<Button onClick={() => setSchedule(true)}>Set a schedule</Button>}>
                  Choose a delivery cadence for your scoped report.
                </Empty>
              )}
            </>
          ) : (
            <p className="body-copy">
              Only the records available to this role are counted. Private deal amounts, internal notes, and unrelated projects are excluded.
            </p>
          )}
        </Card>
      </div>
      {schedule && (
        <Modal title="Keep the team in the loop." onClose={() => setSchedule(false)}>
          <form
            onSubmit={event => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              dispatch({
                type: "REPORT_SCHEDULE",
                schedule: { email: String(data.get("email")), frequency: String(data.get("frequency")), role: state.role, range },
              });
              setSchedule(false);
              notify("Demo report schedule saved");
            }}
          >
            <Field label="Recipient">
              <input type="email" name="email" placeholder="team@example.com" required />
            </Field>
            <Field label="Frequency">
              <Select name="frequency">
                <option>Weekly on Monday</option>
                <option>Monthly on the first</option>
              </Select>
            </Field>
            <p className="muted">This prototype saves the schedule locally. No email is sent.</p>
            <button className="button primary" type="submit">
              Save schedule
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}

const shown = value => (value === null || value === undefined || value === "" ? "(empty)" : typeof value === "object" ? JSON.stringify(value) : String(value));

export function Sync() {
  const { state, dispatch, notify } = useCrm();
  const queue = state.queue.filter(item => item.actor === ROLES[state.role].person);
  const [resolution, setResolution] = useState(null);
  const pending = queue.filter(item => item.status !== "Conflict" && item.kind !== "Communication draft");
  return (
    <>
      <PageHeader title="Sync" description="Changes waiting to be sent, and any that need your decision.">
        <Button
          variant="primary"
          icon={CloudArrowUp}
          disabled={!state.online || !pending.length}
          onClick={() => {
            dispatch({ type: "SYNC" });
            notify("Eligible demo changes synchronized. Draft messages were not sent.");
          }}
        >
          Sync pending changes
        </Button>
      </PageHeader>
      <div className="two-columns">
        <Card
          title={state.online ? "Connected · ready to sync" : "Offline · your work is still here"}
          subtitle="Local Skip Tracing remains available without the server."
        >
          <div className="sync-count">
            {queue.length}
            <small>pending items on this device</small>
          </div>
          <Button onClick={() => dispatch({ type: "CONNECT", online: !state.online })}>{state.online ? "Preview offline mode" : "Reconnect preview"}</Button>
        </Card>
        <Card title="Cached by the kind of data" subtitle="Freshness and safety have different needs.">
          <div className="definition-list">
            <div>
              <small>CRM records</small>
              <strong>Cached view + queued edits</strong>
            </div>
            <div>
              <small>Permissions & contact eligibility</small>
              <strong>Rechecked on connection</strong>
            </div>
            <div>
              <small>Source lists</small>
              <strong>Immutable pinned snapshots</strong>
            </div>
            <div>
              <small>Communication drafts</small>
              <strong>Review before sending</strong>
            </div>
          </div>
        </Card>
      </div>
      <Card
        title="Pending changes"
        subtitle="This is a local UI simulation of the planned synchronization flow."
        action={queue.length > 0 && <Button onClick={() => dispatch({ type: "CONFLICT" })}>Preview a conflict</Button>}
      >
        {queue.map(item => (
          <div className="sync-item" key={item.id}>
            <span>{item.status === "Conflict" ? <WarningCircle size={21} /> : <Clock size={21} />}</span>
            <div>
              <strong>{item.label}</strong>
              <small>
                {item.kind} · {item.actor}
              </small>
            </div>
            <Status value={item.status} />
            {["Conflict", "Rejected"].includes(item.status) && (
              <Button onClick={() => setResolution(item)}>{item.status === "Conflict" ? "Review conflict" : "Review"}</Button>
            )}
            {item.status === "Rejected" && item.serverValue && <small className="muted">{item.serverValue}</small>}
            {item.kind === "Communication draft" && <Badge>Not sent</Badge>}
          </div>
        ))}
        {!queue.length && <Empty title="Everything on this device is in sync">Try offline mode, add a lead note or change a stage, then return here.</Empty>}
      </Card>
      {resolution && (
        <Modal title="Two people changed the same record." onClose={() => setResolution(null)}>
          <p className="body-copy">{resolution.label}</p>
          {resolution.fields ? (
            <div className="conflict-fields">
              {Object.entries(resolution.fields).map(([field, values]) => (
                <div className="conflict-options" key={field}>
                  <Card title={"Your change · " + field.replaceAll("_", " ")}>
                    <p>{shown(values.local)}</p>
                    <Badge>This device</Badge>
                  </Card>
                  <Card title="Now on the server">
                    <p>{shown(values.server)}</p>
                    <Badge tone="peach">Changed since you edited it (was {shown(values.base)})</Badge>
                  </Card>
                </div>
              ))}
            </div>
          ) : (
            <div className="conflict-options">
              <Card title="Your pending change">
                <p>{resolution.label}</p>
                <Badge>This device</Badge>
              </Card>
              <Card title="Server version">
                <p>{resolution.serverValue || "A teammate updated the record while you were offline."}</p>
                <Badge>{state.remote ? "Not applied" : "Simulated conflict"}</Badge>
              </Card>
            </div>
          )}
          <p className="muted">
            {state.remote
              ? "Keeping yours applies it over the server's value. Using the server's drops your change. Nothing is replaced without your choice."
              : "A production sync would show both field values. Here you can review the pending operation or discard it."}
          </p>
          <div className="row">
            {(!state.remote || resolution.status === "Conflict") && (
              <Button
                variant="primary"
                onClick={() => {
                  dispatch({ type: "RESOLVE", id: resolution.id });
                  setResolution(null);
                  notify(state.remote ? "Your change will be applied over the server's" : "Local change reviewed; ready for demo sync");
                }}
              >
                Keep my change
              </Button>
            )}
            <Button
              onClick={() => {
                dispatch({ type: "RESOLVE", id: resolution.id, discard: true });
                setResolution(null);
                notify(
                  state.remote ? "Your change was dropped; the server's value stays" : "Pending operation discarded; optimistic preview values remain local",
                );
              }}
            >
              {state.remote ? "Use the server's" : "Discard pending operation"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function Settings({ section = "workspace" }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const [permissionRole, setPermissionRole] = useState("caller");
  const [integration, setIntegration] = useState(null);
  const admin = capability(state, "admin");
  const rules = capability(state, "rules");
  const sections = [
    { id: "workspace", label: "Workspace", icon: GearSix },
    ...(rules ? [{ id: "rules", label: "Follow-up rules", icon: Clock }] : []),
    ...(admin
      ? [
          { id: "permissions", label: "People & permissions", icon: ShieldCheck },
          { id: "integrations", label: "Communication", icon: Envelope },
          { id: "services", label: "Services & storage", icon: Database },
        ]
      : []),
  ];
  if (!sections.some(item => item.id === section))
    return <Empty title="This settings page is outside your role">Choose a section available in your workspace.</Empty>;
  return (
    <>
      <PageHeader title="Settings" description="Workspace defaults, access and connections." />
      <div className="settings-tabs">
        {sections.map(item => (
          <Button key={item.id} icon={item.icon} variant={section === item.id ? "primary" : ""} onClick={() => navigate("settings/" + item.id)}>
            {item.label}
          </Button>
        ))}
      </div>
      {section === "workspace" && (
        <div className="two-columns">
          <Card title="Workspace details">
            <form
              onSubmit={event => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                dispatch({
                  type: "SETTINGS",
                  settings: { workspace: String(data.get("workspace")), timezone: String(data.get("timezone")), dailyGoal: Number(data.get("goal")) },
                });
                notify("Workspace settings saved");
              }}
            >
              <Field label="Workspace name">
                <input name="workspace" defaultValue={state.settings.workspace} required />
              </Field>
              <Field label="Display timezone">
                <Select name="timezone" defaultValue={state.settings.timezone}>
                  <option>America/New_York</option>
                  <option>America/Chicago</option>
                  <option>America/Los_Angeles</option>
                  <option>Africa/Cairo</option>
                </Select>
              </Field>
              <Field label="Daily outreach goal">
                <input name="goal" type="number" min="1" max="500" defaultValue={state.settings.dailyGoal} />
              </Field>
              <button className="button primary" type="submit">
                Save settings
              </button>
            </form>
          </Card>
          <Card title="A shared workspace, a clear owner">
            <div className="workspace-members">
              {["Maya Chen", "Alex Rivera", "Ben Carter", "Lena Brooks"].map(name => (
                <div key={name}>
                  <Person name={name} />
                  <Badge>{name === "Maya Chen" ? "Caller" : name === "Alex Rivera" ? "Closer" : name === "Ben Carter" ? "Research" : "Manager"}</Badge>
                </div>
              ))}
            </div>
            <p className="body-copy">
              Solo operators can use the same workflows from one workspace. Team members see the records and actions their roles allow.
            </p>
          </Card>
        </div>
      )}
      {section === "rules" && (
        <Card title="A small rule can save a follow-up" subtitle="Versioned rules in the preview. External automation is not executed.">
          {state.rules.map(rule => (
            <div className="rule-row" key={rule.id}>
              <div>
                <strong>{rule.name}</strong>
                <p>When: {rule.when}</p>
                <small>Then: {rule.action}</small>
              </div>
              <label className="switch-label">
                <input
                  type="checkbox"
                  aria-label={"Enable " + rule.name}
                  checked={rule.enabled}
                  onChange={() => {
                    dispatch({ type: "RULE", id: rule.id });
                    notify(rule.enabled ? "Rule paused" : "Rule enabled");
                  }}
                />
                <span>{rule.enabled ? "Enabled" : "Paused"}</span>
              </label>
              <Button onClick={() => notify("Preview: " + rule.action + ". No external action performed.")}>Preview rule</Button>
            </div>
          ))}
        </Card>
      )}
      {section === "permissions" && (
        <>
          <Card
            title="A role is a set of capabilities"
            subtitle="Presets demonstrate record scope and actions. Server enforcement belongs to the backend plan."
          >
            <Field label="Role preset">
              <Select aria-label="Permission role preset" value={permissionRole} onChange={event => setPermissionRole(event.target.value)}>
                {Object.entries(ROLES).map(([id, role]) => (
                  <option value={id} key={id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="permission-scope">
              <ShieldCheck size={22} />
              <div>
                <strong>{ROLES[permissionRole].scope}</strong>
                <p>{ROLES[permissionRole].title}</p>
              </div>
              <Badge>Preview preset</Badge>
            </div>
            <div className="permission-grid">
              {[
                ["edit", "Edit visible leads"],
                ["assign", "Assign responsibility"],
                ["handoff", "Request handoffs"],
                ["accept", "Accept handoffs"],
                ["call", "Work calling queue"],
                ["message", "Use conversations"],
                ["export", "Export visible records"],
                ["finance", "View deal financials"],
                ["import", "Import source data"],
                ["review", "Review Skip Tracing"],
                ["rules", "Configure rules"],
                ["admin", "Administer workspace"],
              ].map(([name, label]) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={state.permissions[permissionRole]?.[name] ?? ROLES[permissionRole].capabilities.includes(name)}
                    onChange={event => dispatch({ type: "PERMISSION", role: permissionRole, name, allowed: event.target.checked })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </Card>
          <div className="notice subtle">
            <LockKey size={18} />
            System access and private business access are separate. Client records remain explicitly shared.
          </div>
        </>
      )}
      {section === "integrations" && (
        <div className="integration-grid">
          {[
            ["Email", "SMTP / IMAP · Google · Microsoft", "Keep inbound and outbound conversations with the lead."],
            ["SMS", "Twilio · provider adapter", "Replies, templates, opt-outs, and delivery state."],
            ["Voice", "Twilio · browser companion", "A shared queue, transfers, voicemail, and recordings."],
          ].map(([name, provider, description]) => (
            <Card
              key={name}
              title={name}
              subtitle={provider}
              action={<Badge tone={state.integrations[name] ? "good" : ""}>{state.integrations[name] ? "Demo connected" : "Not configured"}</Badge>}
            >
              <p className="body-copy">{description}</p>
              <Button variant={state.integrations[name] ? "" : "primary"} onClick={() => setIntegration(name)}>
                {state.integrations[name] ? "Manage preview" : "Configure preview"}
              </Button>
            </Card>
          ))}
        </div>
      )}
      {section === "services" && (
        <>
          <Card title="One system, clear responsibilities" subtitle="Architecture preview only. These services are planned, not running behind this prototype.">
            <div className="service-grid">
              {[
                ["Rust", "Core API & authorization", "backend/rust"],
                ["Python", "Skip Tracing & ML", "backend/python"],
                ["Go", "Scheduling & notifications", "backend/go"],
                ["C++", "Batch comparison engine", "backend/cpp"],
                ["C", "Audio & media", "backend/c"],
                ["JavaScript", "Provider adapters", "backend/javascript"],
              ].map(([name, purpose, folder]) => (
                <div key={name}>
                  <HardDrives size={25} weight="light" />
                  <h3>{name}</h3>
                  <p>{purpose}</p>
                  <code>{folder}/</code>
                  <Badge>Planned container</Badge>
                </div>
              ))}
            </div>
          </Card>
          <div className="two-columns">
            <Card title="Canonical data">
              <Database size={28} />
              <h3>PostgreSQL</h3>
              <p className="body-copy">Authoritative records, durable jobs, synchronization history, and access-aware transactions.</p>
            </Card>
            <Card title="Main shared cache">
              <CloudArrowUp size={28} />
              <h3>Redis</h3>
              <p className="body-copy">Scoped projections and short-lived results. Immutable files live in artifact storage; pending edits remain durable.</p>
            </Card>
          </div>
        </>
      )}
      {integration && (
        <Modal title={integration + " connection preview"} onClose={() => setIntegration(null)}>
          <form
            onSubmit={event => {
              event.preventDefault();
              dispatch({ type: "INTEGRATION", name: integration, connected: true });
              notify(integration + " preview marked connected. No credentials were sent.");
              setIntegration(null);
            }}
          >
            <p className="body-copy">Preview the connection state without entering real provider credentials.</p>
            <Field label="Display name">
              <input placeholder={"Team " + integration.toLowerCase() + " account"} required />
            </Field>
            <Field label="Provider">
              <Select>
                {(integration === "Email" ? ["SMTP / IMAP", "Google Workspace", "Microsoft 365"] : ["Twilio", "Custom provider adapter"]).map(provider => (
                  <option key={provider}>{provider}</option>
                ))}
              </Select>
            </Field>
            <div className="row">
              <button className="button primary" type="submit">
                Save demo connection
              </button>
              {state.integrations[integration] && (
                <Button
                  onClick={() => {
                    dispatch({ type: "INTEGRATION", name: integration, connected: false });
                    setIntegration(null);
                    notify("Demo connection removed");
                  }}
                >
                  Disconnect preview
                </Button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
