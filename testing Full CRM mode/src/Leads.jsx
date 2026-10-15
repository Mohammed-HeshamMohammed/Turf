import { useState } from "react";
import { PropertyMap } from "./PropertyMap.jsx";
import { coordinates } from "./skiptrace-fields.js";
import { ArrowUpRight, ArrowLeft, Plus, Phone, Envelope, Handshake, Clock, FileText, CheckCircle, Export, HouseLine } from "@phosphor-icons/react";
import { LEAD_STAGES, PEOPLE, ROLES, TODAY } from "./data.js";
import { callbackLabel, canEditLead, capability, uid, visibleLeads } from "./model.js";
import { CallHistory } from "./Work.jsx";
import { useCrm } from "./context.jsx";
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, Person, RoundButton, Search, Segmented, Status, downloadCsv, money, Breadcrumb } from "./ui.jsx";

export function Leads() {
  const { state, navigate, dispatch, notify, route } = useCrm();
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState(new URLSearchParams(route.split("?")[1]).get("stage") || "All stages");
  const [view, setView] = useState("List");
  const [selected, setSelected] = useState([]);
  const [bulkStage, setBulkStage] = useState("Contacted");
  const [assignee, setAssignee] = useState("All people");
  const client = state.role === "client";
  const leads = visibleLeads(state).filter(
    lead =>
      (stage === "All stages" || lead.stage === stage) &&
      (assignee === "All people" || lead.assignee === assignee) &&
      [lead.name, lead.address, lead.city, ...(client ? [] : [lead.phone, lead.email])].join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  const editable = capability(state, "edit");
  function exportRows() {
    downloadCsv("turf-visible-leads.csv", [
      ["Owner", "Property", "City", "Stage", "Assigned to"],
      ...leads.map(lead => [lead.name, lead.address, lead.city, lead.stage, lead.assignee]),
    ]);
    notify("Visible leads exported");
  }
  return (
    <>
      <PageHeader
        eyebrow={ROLES[state.role].scope}
        title={client ? "Your shared properties" : "Leads, with a little more context."}
        description={
          client ? "Only records explicitly shared with your partner workspace." : "Keep the property, the person, and the next conversation together."
        }
      >
        {capability(state, "export") && (
          <Button icon={Export} onClick={exportRows}>
            Export view
          </Button>
        )}
        {editable && (
          <Button variant="primary" icon={Plus} onClick={() => navigate("work/leads/new")}>
            New lead
          </Button>
        )}
      </PageHeader>
      <div className="filter-bar">
        <Search value={search} onChange={setSearch} placeholder={client ? "Search shared properties" : "Search owner, property, or phone"} />
        {!client && (
          <>
            <select aria-label="Filter by lead stage" value={stage} onChange={event => setStage(event.target.value)}>
              <option>All stages</option>
              {LEAD_STAGES.map(item => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <select aria-label="Filter by assigned person" value={assignee} onChange={event => setAssignee(event.target.value)}>
              <option>All people</option>
              {[...PEOPLE, "Unassigned"].map(item => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </>
        )}
        <Segmented label="Lead view" value={view} options={client ? ["List", "Map"] : ["List", "Board", "Map"]} onChange={setView} />
        <span className="result-count">
          {leads.length} {client ? "properties" : "leads"}
        </span>
      </div>
      {selected.length > 0 && (
        <div className="bulk-bar">
          <strong>{selected.length} selected</strong>
          <select aria-label="Bulk lead stage" value={bulkStage} onChange={event => setBulkStage(event.target.value)}>
            {LEAD_STAGES.map(item => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <Button
            onClick={() => {
              selected.forEach(id => dispatch({ type: "UPDATE_LEAD", id, change: { stage: bulkStage } }));
              setSelected([]);
              notify("Selected leads updated");
            }}
          >
            Apply stage
          </Button>
          <button className="text-button" onClick={() => setSelected([])}>
            Clear selection
          </button>
        </div>
      )}
      {view === "Map" ? (
        <PropertyMap rows={leads} title={client ? "Shared property map" : "Lead map"} />
      ) : view === "Board" && !client ? (
        <div className="kanban lead-board">
          {LEAD_STAGES.map(column => (
            <section
              className="kanban-column"
              key={column}
              onDragOver={event => event.preventDefault()}
              onDrop={event => {
                const id = event.dataTransfer.getData("text/plain");
                if (canEditLead(state, id)) {
                  dispatch({ type: "UPDATE_LEAD", id, change: { stage: column } });
                  notify("Lead moved to " + column);
                }
              }}
            >
              <header>
                <span>{column}</span>
                <Badge>{leads.filter(lead => lead.stage === column).length}</Badge>
              </header>
              {leads
                .filter(lead => lead.stage === column)
                .map(lead => (
                  <article
                    className="kanban-card"
                    key={lead.id}
                    draggable={canEditLead(state, lead.id)}
                    onDragStart={event => event.dataTransfer.setData("text/plain", lead.id)}
                  >
                    <button onClick={() => navigate("work/leads/" + lead.id)}>
                      <strong>{lead.name}</strong>
                      <span>{lead.address}</span>
                      <small>
                        {lead.city}, {lead.region}
                      </small>
                    </button>
                    <Status value={lead.verdict} />
                    <Person name={lead.assignee} />
                    {canEditLead(state, lead.id) && (
                      <select
                        aria-label={"Move " + lead.name + " to stage"}
                        value={lead.stage}
                        onChange={event => dispatch({ type: "UPDATE_LEAD", id: lead.id, change: { stage: event.target.value } })}
                      >
                        {LEAD_STAGES.map(item => (
                          <option key={item}>{item}</option>
                        ))}
                      </select>
                    )}
                  </article>
                ))}
              {!leads.some(lead => lead.stage === column) && <p className="column-empty">No leads here</p>}
            </section>
          ))}
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {editable && (
                    <th className="checkbox-cell">
                      <input
                        type="checkbox"
                        aria-label="Select all editable visible leads"
                        checked={
                          leads.some(lead => canEditLead(state, lead.id)) &&
                          leads.filter(lead => canEditLead(state, lead.id)).every(lead => selected.includes(lead.id))
                        }
                        onChange={event => setSelected(event.target.checked ? leads.filter(lead => canEditLead(state, lead.id)).map(lead => lead.id) : [])}
                      />
                    </th>
                  )}
                  <th>Property owner</th>
                  <th>Property</th>
                  {!client && <th>Phone quality</th>}
                  <th>Stage</th>
                  {!client && <th>Responsible person</th>}
                  <th>Next step</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {leads.map(lead => (
                  <tr key={lead.id}>
                    {editable && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={"Select " + lead.name}
                          disabled={!canEditLead(state, lead.id)}
                          checked={selected.includes(lead.id)}
                          onChange={event => setSelected(event.target.checked ? [...selected, lead.id] : selected.filter(id => id !== lead.id))}
                        />
                      </td>
                    )}
                    <td>
                      <button className="lead-link" onClick={() => navigate("work/leads/" + lead.id)}>
                        <strong>{lead.name}</strong>
                        <small>{lead.source}</small>
                      </button>
                    </td>
                    <td>
                      <span>{lead.address}</span>
                      <small>
                        {lead.city}, {lead.region} {lead.zip}
                      </small>
                    </td>
                    {!client && (
                      <td>
                        <Status value={lead.verdict} />
                      </td>
                    )}
                    <td>
                      <Status value={lead.stage} />
                    </td>
                    {!client && (
                      <td>
                        <Person name={lead.assignee} />
                      </td>
                    )}
                    <td>
                      {client ? (
                        "Review property brief"
                      ) : lead.callback ? (
                        <span className="inline">
                          <Clock size={14} />
                          {callbackLabel(lead.callbackDate, lead.callback)}
                        </span>
                      ) : (
                        <span className="muted">Set a next step</span>
                      )}
                    </td>
                    <td>
                      <RoundButton label={"Open " + lead.name} onClick={() => navigate("work/leads/" + lead.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!leads.length && <Empty title="No leads match this view">Try another stage or search term.</Empty>}
          <footer className="table-footer">
            <span>{ROLES[state.role].scope}</span>
            <span>{leads.length} records · sample workspace</span>
          </footer>
        </div>
      )}
    </>
  );
}

export function LeadDetail({ id }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const lead = visibleLeads(state).find(item => item.id === id);
  const [tab, setTab] = useState("Overview");
  const [note, setNote] = useState("");
  const [visibility, setVisibility] = useState("internal");
  const [handoff, setHandoff] = useState(false);
  const [recipient, setRecipient] = useState("Alex Rivera");
  const [handoffNote, setHandoffNote] = useState("");
  const [document, setDocument] = useState(false);
  if (!lead)
    return (
      <Empty title="This record is outside your view" action={<Button onClick={() => navigate("work/leads")}>Back to visible leads</Button>}>
        Switch to a role with access, or return to the records shared with you.
      </Empty>
    );
  const client = state.role === "client";
  const editable = canEditLead(state, id);
  const notes = lead.notes.filter(item => !client || item.visibility === "shared");
  const activities = state.activities.filter(item => item.leadId === id);
  const tasks = state.tasks.filter(item => item.leadId === id && (!client || item.shared));
  const pending = state.queue.some(item => item.leadId === id);
  return (
    <>
      <Breadcrumb items={[{ label: client ? "Shared properties" : "Leads", path: "work/leads" }, { label: lead.name }]} />
      <PageHeader
        eyebrow={lead.address + " · " + lead.city}
        title={lead.name}
        description={client ? "Property information approved for your workspace." : "A person, a property, and a shared next step."}
      >
        {pending && <Badge tone="peach">Pending sync</Badge>}
        {editable && capability(state, "handoff") && (
          <Button
            icon={Handshake}
            onClick={() => {
              setHandoffNote(lead.motivation);
              setHandoff(true);
            }}
          >
            Request handoff
          </Button>
        )}
        {capability(state, "call") && (
          <Button variant="primary" icon={Phone} disabled={lead.verdict === "Do not call"} onClick={() => navigate("work/calls/" + id)}>
            Call workspace
          </Button>
        )}
      </PageHeader>
      <div className="detail-grid">
        <div>
          <div className="card property-detail">
            <div className="detail-photo">
              <img src="/assets/property.jpg" alt="Illustrative sample Florida house" />
              <span className="image-caption">Illustrative sample photo</span>
            </div>
            <div>
              <div className="row">
                <Status value={lead.stage} />
                {!client && <Badge>{lead.source}</Badge>}
              </div>
              <h2>{lead.address}</h2>
              <p>
                {lead.city}, {lead.region} {lead.zip}
              </p>
              <div className="property-facts">
                <span>{lead.beds} beds</span>
                <span>{lead.baths} baths</span>
                <span>{lead.area.toLocaleString()} sq ft</span>
              </div>
              {capability(state, "finance") && (
                <div className="property-value">
                  <small>Estimated property value</small>
                  <strong>{money(lead.value)}</strong>
                </div>
              )}
              <div className="row">
                <HouseLine size={17} />
                <small>One property · linked to {state.leads.filter(item => item.name === lead.name).length} lead record</small>
              </div>
            </div>
          </div>
          <div className="detail-tabs">
            <Segmented
              label="Lead record sections"
              value={tab}
              onChange={setTab}
              options={client ? ["Overview", "Documents"] : ["Overview", "Activity", "Documents", "Evidence"]}
            />
          </div>
          <PropertyMap rows={[lead]} title="Property location" compact />
          {tab === "Overview" && (
            <>
              <Card title={client ? "Approved property context" : "The conversation so far"}>
                <p className="body-copy">
                  {client
                    ? "Your team has shared this property for review. Use the approved brief below and ask questions in the shared notes."
                    : lead.motivation}
                </p>
                {!client && (
                  <div className="detail-fields">
                    <div>
                      <small>Email</small>
                      <span>{lead.email}</span>
                    </div>
                    <div>
                      <small>Best phone</small>
                      <span>{lead.phone}</span>
                    </div>
                    <div>
                      <small>Responsible person</small>
                      <Person name={lead.assignee} />
                    </div>
                    <div>
                      <small>Team</small>
                      <span>{lead.team} acquisitions</span>
                    </div>
                  </div>
                )}
              </Card>
              <Card
                title={client ? "Shared notes" : "Notes & context"}
                subtitle={client ? "Visible to you and the project team." : "Keep important details attached to the lead."}
              >
                {notes.map(item => (
                  <article className="note" key={item.id}>
                    <p>{item.text}</p>
                    <div>
                      <small>
                        {item.actor} · {item.at}
                      </small>
                      <Badge>{item.visibility === "shared" ? "Shared with partner" : "Internal"}</Badge>
                    </div>
                  </article>
                ))}
                {!notes.length && <p className="muted">No shared notes yet.</p>}
                {(editable || capability(state, "publicComment")) && (
                  <form
                    className="note-form"
                    onSubmit={event => {
                      event.preventDefault();
                      dispatch({ type: "NOTE", leadId: id, text: note, visibility });
                      setNote("");
                      notify(state.online ? "Note saved" : "Note added to the offline queue");
                    }}
                  >
                    <label className="sr-only" htmlFor="lead-note">
                      Add a lead note
                    </label>
                    <textarea
                      id="lead-note"
                      placeholder={client ? "Ask a question about this property…" : "What should the next person know?"}
                      value={note}
                      onChange={event => setNote(event.target.value)}
                      required
                    />
                    <div className="row">
                      {!client && (
                        <select aria-label="Note visibility" value={visibility} onChange={event => setVisibility(event.target.value)}>
                          <option value="internal">Internal note</option>
                          {lead.shared && <option value="shared">Shared with partner</option>}
                        </select>
                      )}
                      <Button variant="primary" disabled={!note.trim()} onClick={event => event.currentTarget.closest("form").requestSubmit()}>
                        Save note
                      </Button>
                    </div>
                  </form>
                )}
              </Card>
            </>
          )}
          {tab === "Activity" && <CallHistory calls={[...(lead.calls || [])].reverse()} />}
          {tab === "Activity" && (
            <Card title="The full lead history" subtitle="Calls, stage changes, notes, and handoffs.">
              {activities.map(item => (
                <div className="activity-item" key={item.id}>
                  <CheckCircle size={21} weight="light" />
                  <div>
                    <p>{item.text}</p>
                    <small>
                      {item.actor} · {item.time}
                    </small>
                  </div>
                  <Badge>{item.kind}</Badge>
                </div>
              ))}
              {!activities.length && <Empty title="A new story starts here">Actions taken on this lead appear here.</Empty>}
              {notes.map(item => (
                <article className="note" key={item.id}>
                  <p>{item.text}</p>
                  <small>
                    Note · {item.actor} · {item.at}
                  </small>
                </article>
              ))}
            </Card>
          )}
          {tab === "Documents" && (
            <Card title="Documents" subtitle={client ? "Only approved documents are shared here." : "Briefs and files connected to this property."}>
              <div className="document-row">
                <FileText size={32} weight="light" />
                <div>
                  <strong>Property brief · {lead.address}</strong>
                  <small>Approved summary · sample document</small>
                </div>
                <Badge tone="good">Approved</Badge>
                <Button onClick={() => setDocument(true)}>Open brief</Button>
              </div>
              {!client && (
                <div className="document-row">
                  <FileText size={32} weight="light" />
                  <div>
                    <strong>Source lineage</strong>
                    <small>{state.datasets.find(item => item.id === lead.datasetId)?.name || "Imported file"}</small>
                  </div>
                  <Badge>Internal</Badge>
                  <Button onClick={() => navigate("lists/" + lead.datasetId)}>View source</Button>
                </div>
              )}
            </Card>
          )}
          {tab === "Evidence" && !client && (
            <Card title="Phone & source evidence" subtitle="Separate contact quality from permission to contact.">
              <div className="evidence-grid">
                <div>
                  <small>Contact quality</small>
                  <Status value={lead.verdict} />
                </div>
                <div>
                  <small>Permission</small>
                  <Badge tone={lead.verdict === "Do not call" ? "danger" : ""}>{lead.verdict === "Do not call" ? "Blocked" : "Review before contacting"}</Badge>
                </div>
                <div>
                  <small>Source</small>
                  <strong>{lead.source}</strong>
                </div>
                <div>
                  <small>Freshness</small>
                  <strong>Sample evidence · October 14</strong>
                </div>
              </div>
              <p className="notice subtle">
                This preview uses illustrative evidence. A real check and current contact permissions are required in the application.
              </p>
              <Button onClick={() => navigate("lists/" + lead.datasetId)}>
                Open original source <ArrowUpRight size={16} />
              </Button>
            </Card>
          )}
        </div>
        <aside className="detail-aside">
          <Card title="Next step">
            {!client && (
              <>
                <Field label="Lead stage">
                  <select
                    aria-label="Lead stage"
                    disabled={!editable}
                    value={lead.stage}
                    onChange={event => {
                      dispatch({ type: "UPDATE_LEAD", id, change: { stage: event.target.value } });
                      notify("Lead stage updated");
                    }}
                  >
                    {LEAD_STAGES.map(item => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Callback date">
                  <input
                    aria-label="Callback date"
                    type="date"
                    min={TODAY}
                    disabled={!editable}
                    value={lead.callbackDate || ""}
                    onChange={event => dispatch({ type: "UPDATE_LEAD", id, change: { callbackDate: event.target.value, callback: event.target.value ? lead.callback || "10:00" : "" } })}
                  />
                </Field>
                <Field label="Callback time">
                  <input
                    aria-label="Callback time"
                    type="time"
                    disabled={!editable}
                    value={lead.callback}
                    onChange={event => dispatch({ type: "UPDATE_LEAD", id, change: { callback: event.target.value, callbackDate: event.target.value ? lead.callbackDate || TODAY : "" } })}
                  />
                </Field>
                {capability(state, "assign") && (
                  <Field label="Responsible person" help={!state.online ? "Assignment needs an online connection." : "Changes follow the lead across lists."}>
                    <select
                      aria-label="Responsible person"
                      disabled={!state.online}
                      value={lead.assignee}
                      onChange={event => {
                        dispatch({ type: "UPDATE_LEAD", id, change: { assignee: event.target.value } });
                        notify("Lead assignment updated");
                      }}
                    >
                      {[...PEOPLE, "Unassigned"].map(name => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </Field>
                )}
              </>
            )}
            {tasks
              .filter(task => !task.done)
              .map(task => (
                <div className="compact-task" key={task.id}>
                  <Clock size={17} />
                  <div>
                    <strong>{task.title}</strong>
                    <small>
                      {task.time} · {task.date}
                    </small>
                  </div>
                </div>
              ))}
            {!tasks.length && <p className="muted">{client ? "No shared actions waiting." : "No tasks attached to this lead."}</p>}
            <Button onClick={() => navigate("work/tasks")}>
              Open tasks <ArrowUpRight size={15} />
            </Button>
          </Card>
          {!client && (
            <Card title="Contact">
              <div className="contact-line">
                <Phone size={18} />
                <span>{lead.phone}</span>
              </div>
              <div className="contact-line">
                <Envelope size={18} />
                <span>{lead.email}</span>
              </div>
              {capability(state, "message") && <Button onClick={() => navigate("work/inbox?lead=" + id)}>Open conversation</Button>}
              <Status value={lead.verdict} />
            </Card>
          )}
          <Card title={client ? "Shared by your team" : "Source & ownership"}>
            <p className="body-copy">
              {client
                ? "Oak & Palm Partners has approved this property for your review."
                : state.datasets.find(item => item.id === lead.datasetId)?.name || "Added manually"}
            </p>
            {!client && <Person name={lead.assignee} />}
            <small>Record version {lead.version}</small>
          </Card>
        </aside>
      </div>
      {handoff && (
        <Modal title="Give the next person a good start." onClose={() => setHandoff(false)}>
          <p className="muted">Request a handoff for {lead.name}. Responsibility changes when the recipient accepts.</p>
          <form
            onSubmit={event => {
              event.preventDefault();
              dispatch({ type: "HANDOFF", leadId: id, to: recipient, note: handoffNote });
              setHandoff(false);
              notify("Handoff requested");
              navigate("work/handoffs");
            }}
          >
            <Field label="Send to">
              <select aria-label="Handoff recipient" value={recipient} onChange={event => setRecipient(event.target.value)}>
                {PEOPLE.filter(name => name !== ROLES[state.role].person).map(name => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Field>
            <Field label="Qualification & seller context">
              <textarea aria-label="Handoff context" required value={handoffNote} onChange={event => setHandoffNote(event.target.value)} />
            </Field>
            <button
              className="button primary"
              type="submit"
              disabled={!handoffNote.trim() || state.handoffs.some(item => item.leadId === id && item.status === "Requested")}
            >
              <Handshake size={17} />
              Request handoff
            </button>
          </form>
        </Modal>
      )}
      {document && (
        <Modal title="Approved property brief" onClose={() => setDocument(false)}>
          <article className="property-brief">
            <Badge tone="good">Shared property summary</Badge>
            <h3>{lead.address}</h3>
            <p>
              {lead.city}, {lead.region} {lead.zip}
            </p>
            <p>
              {lead.beds} bedrooms · {lead.baths} bathrooms · {lead.area.toLocaleString()} square feet
            </p>
            <p>
              This fictional property is included in the sample project. Your team will attach the approved inspection and closing documents as the transaction
              progresses.
            </p>
            <strong>Project contact: Oak & Palm Partners</strong>
          </article>
          <Button onClick={() => window.print()}>Print brief</Button>
        </Modal>
      )}
    </>
  );
}

export function NewLead() {
  const { state, navigate, dispatch, notify } = useCrm();
  if (!capability(state, "edit")) return <Empty title="Lead creation is outside this role">Choose a role with permission to add leads.</Empty>;
  return (
    <>
      <Breadcrumb items={[{ label: "Leads", path: "work/leads" }, { label: "New lead" }]} />
      <PageHeader title="Start with the person and property." description="Add a lead, give it an owner, and keep the next step clear." />
      <form
        className="card creation-form"
        onSubmit={event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const latitude = String(form.get("latitude") || "").trim();
          const longitude = String(form.get("longitude") || "").trim();
          if ((latitude || longitude) && !coordinates(latitude, longitude)) {
            notify("Supply both valid latitude and longitude, or leave both blank.");
            return;
          }
          const id = uid();
          const lead = {
            id,
            name: String(form.get("name")).trim(),
            address: String(form.get("address")).trim(),
            city: String(form.get("city")).trim(),
            region: String(form.get("region") || "").trim(),
            country: String(form.get("country") || "").trim(),
            unit: String(form.get("unit") || "").trim(),
            latitude,
            longitude,
            zip: String(form.get("zip")),
            phone: String(form.get("phone")),
            email: String(form.get("email")),
            source: "Added manually",
            assignee: String(form.get("assignee") || ROLES[state.role].person),
            team: ROLES[state.role].team || "Tampa",
            datasetId: "d04",
            stage: "New",
            callback: String(form.get("callback")),
            callbackDate: form.get("callback") ? TODAY : "",
            calls: [],
            verdict: "Unverified",
            shared: false,
            version: 1,
            priority: "Normal",
            motivation: String(form.get("context")),
            notes: [],
            value: Number(form.get("value")) || 0,
            beds: 3,
            baths: 2,
            area: 1600,
          };
          dispatch({ type: "NEW_LEAD", lead });
          notify(state.online ? "Lead created" : "Lead queued for sync");
          navigate("work/leads/" + id);
        }}
      >
        <h2>Lead details</h2>
        <div className="form-grid">
          <Field label="Property owner">
            <input name="name" autoComplete="off" required placeholder="Full name" />
          </Field>
          <Field label="Property address">
            <input name="address" required placeholder="Street address" />
          </Field>
          <Field label="City">
            <input name="city" required defaultValue="Tampa" />
          </Field>
          <Field label="State / region">
            <input name="region" defaultValue="FL" />
          </Field>
          <Field label="Country">
            <input name="country" defaultValue="US" />
          </Field>
          <Field label="Unit / address line 2">
            <input name="unit" />
          </Field>
          <Field label="ZIP code">
            <input name="zip" placeholder="ZIP or postal code" />
          </Field>
          <Field label="Latitude" help="Optional · both coordinates are needed for a map pin.">
            <input name="latitude" type="number" min="-90" max="90" step="any" />
          </Field>
          <Field label="Longitude">
            <input name="longitude" type="number" min="-180" max="180" step="any" />
          </Field>
          <Field label="Phone">
            <input name="phone" type="tel" placeholder="+1 (813) 555-0100" />
          </Field>
          <Field label="Email">
            <input name="email" type="email" placeholder="owner@example.com" />
          </Field>
          <Field label="Responsible person">
            <select name="assignee" defaultValue={ROLES[state.role].person}>
              {(capability(state, "assign") ? [...PEOPLE, "Unassigned"] : [ROLES[state.role].person]).map(name => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
          <Field label="Callback time">
            <input name="callback" type="time" />
          </Field>
          {capability(state, "finance") && (
            <Field label="Estimated property value">
              <input name="value" type="number" min="0" placeholder="250000" />
            </Field>
          )}
        </div>
        <Field label="What do we know so far?">
          <textarea name="context" placeholder="Seller plans, property context, or the next conversation…" />
        </Field>
        <div className="form-actions">
          <Button icon={ArrowLeft} onClick={() => navigate("work/leads")}>
            Cancel
          </Button>
          <button className="button primary" type="submit">
            <Plus size={17} />
            Create lead
          </button>
        </div>
      </form>
    </>
  );
}
