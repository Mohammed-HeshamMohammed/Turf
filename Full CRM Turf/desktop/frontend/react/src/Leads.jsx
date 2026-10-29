import { useEffect, useRef, useState } from "react";
import { PropertyMap } from "./PropertyMap.jsx";
import { LeadsMap } from "./LeadsMap.jsx";
import { coordinates } from "./skiptrace-fields.js";
import { Archive, ArrowUpRight, ArrowLeft, Plus, Phone, Envelope, Handshake, Clock, FileText, CheckCircle, Export, HouseLine } from "@phosphor-icons/react";
import { LEAD_STAGES, PEOPLE, ROLES, TODAY } from "./data.js";
import { archivedLeads, callbackLabel, canEditLead, capability, scopedLeads, uid, visibleLeads } from "./model.js";
import { CallHistory, NewDealModal } from "./Work.jsx";
import { useCrm } from "./context.jsx";
import {
  Badge,
  BoardColumn,
  useBoardColumns,
  Select,
  Button,
  Card,
  Checkbox,
  Empty,
  Field,
  Modal,
  PageHeader,
  Person,
  RoundButton,
  Search,
  Segmented,
  Status,
  downloadCsv,
  money,
  Breadcrumb,
  ConfirmDialog,
  propertyFacts,
  MoreMenu,
  DataTable,
  DatePicker,
  TimePicker,
  useTableView,
} from "./ui.jsx";

export function Leads() {
  const { state, navigate, dispatch, notify, route } = useCrm();
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState(new URLSearchParams(route.split("?")[1]).get("stage") || "All stages");
  const [view, setView] = useState("List");
  const [selected, setSelected] = useState([]);
  const [bulkStage, setBulkStage] = useState("Contacted");
  const assigneeParam = new URLSearchParams(route.split("?")[1]).get("assignee") || "All people";
  const [assignee, setAssignee] = useState(assigneeParam);
  useEffect(() => setAssignee(assigneeParam), [assigneeParam]);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [drag, setDrag] = useState(null);
  // A board column shows this many cards per stage until "Show more" (a list of thousands stays quick).
  const [boardShown, setBoardShown] = useState({});
  const BOARD_STEP = 50;
  const justDragged = useRef(false);
  const client = state.role === "client";
  const archivedCount = archivedLeads(state).length;
  const leads = (showArchived && archivedCount ? archivedLeads(state) : visibleLeads(state)).filter(
    lead =>
      (stage === "All stages" || lead.stage === stage) &&
      (assignee === "All people" || lead.assignee === assignee) &&
      [lead.name, lead.address, lead.city, ...(client ? [] : [lead.phone, lead.email])].join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  const editable = capability(state, "edit");
  const board = useBoardColumns(LEAD_STAGES, Object.fromEntries(LEAD_STAGES.map(column => [column, leads.filter(lead => lead.stage === column).length])));
  const assigned = lead => lead.assignee && lead.assignee !== "Unassigned";
  const hasColumn = {
    verdict: !hideEmpty || leads.some(lead => lead.verdict),
    assignee: !hideEmpty || leads.some(assigned),
    next: !hideEmpty || client || leads.some(lead => lead.callback),
  };
  const table = useTableView(
    leads,
    {
      owner: { value: lead => lead.name },
      property: { value: lead => lead.address },
      verdict: { value: lead => lead.verdict || "" },
      stage: { value: lead => LEAD_STAGES.indexOf(lead.stage) },
      assignee: { value: lead => lead.assignee || "" },
      next: { value: lead => (lead.callback ? (lead.callbackDate || "") + " " + lead.callback : "￿") },
    },
    "leads",
  );
  // Pointer-based drag so cards move the same way in browsers and the desktop webview, which swallows native drag and drop.
  function startDrag(event, lead) {
    if (event.button !== 0 || event.target.closest(".select") || !canEditLead(state, lead.id)) return;
    const card = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const offset = { x: event.clientX - card.left, y: event.clientY - card.top };
    let active = false;
    let over = null;
    const move = e => {
      if (!active && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      active = true;
      over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-stage]")?.dataset.stage ?? null;
      setDrag({ id: lead.id, label: lead.name, address: lead.address, width: card.width, x: e.clientX - offset.x, y: e.clientY - offset.y, over });
    };
    const finish = e => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setDrag(null);
      if (!active) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      if (e.type !== "pointercancel" && over && over !== lead.stage) {
        dispatch({ type: "UPDATE_LEAD", id: lead.id, change: { stage: over } });
        notify("Lead moved to " + over);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }
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
        title={client ? "Shared properties" : "Leads"}
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
            <Select aria-label="Filter by lead stage" value={stage} onChange={event => setStage(event.target.value)}>
              <option>All stages</option>
              {LEAD_STAGES.map(item => (
                <option key={item}>{item}</option>
              ))}
            </Select>
            <Select aria-label="Filter by assigned person" value={assignee} onChange={event => setAssignee(event.target.value)}>
              <option>All people</option>
              {[...PEOPLE, "Unassigned"].map(item => (
                <option key={item}>{item}</option>
              ))}
            </Select>
          </>
        )}
        <Segmented label="Lead view" value={view} options={client ? ["List", "Map"] : ["List", "Board", "Map"]} onChange={setView} />
        <Checkbox label="Hide empty fields" checked={hideEmpty} onChange={event => setHideEmpty(event.target.checked)} />
        {!client && archivedCount > 0 && (
          <Checkbox label={"Archived (" + archivedCount + ")"} checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />
        )}
        <span className="result-count">
          {leads.length} {client ? "properties" : "leads"}
        </span>
      </div>
      {selected.length > 0 && (
        <div className="bulk-bar">
          <strong>{selected.length} selected</strong>
          <Select aria-label="Bulk lead stage" value={bulkStage} onChange={event => setBulkStage(event.target.value)}>
            {LEAD_STAGES.map(item => (
              <option key={item}>{item}</option>
            ))}
          </Select>
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
        client ? (
          <PropertyMap rows={leads} title="Shared property map" />
        ) : (
          <LeadsMap leads={leads} />
        )
      ) : view === "Board" && !client ? (
        <div className="kanban lead-board view-in" ref={board.ref}>
          {board.arrange(LEAD_STAGES).map(column => (
            <BoardColumn key={column} board={board} id={column} count={leads.filter(lead => lead.stage === column).length} unit="leads" over={drag?.over === column}>
              {leads
                .filter(lead => lead.stage === column)
                .slice(0, boardShown[column] || BOARD_STEP)
                .map(lead => (
                  <article
                    className={"kanban-card" + (drag?.id === lead.id ? " dragging" : "") + (canEditLead(state, lead.id) ? "" : " locked")}
                    key={lead.id}
                    onPointerDown={event => startDrag(event, lead)}
                  >
                    <button
                      onClick={() => {
                        if (!justDragged.current) navigate("work/leads/" + lead.id);
                      }}
                    >
                      <strong>{lead.name}</strong>
                      <span>{lead.address}</span>
                      <small>
                        {lead.city}, {lead.region}
                      </small>
                    </button>
                    {!(hideEmpty && !lead.verdict) && <Status value={lead.verdict} />}
                    {!(hideEmpty && !assigned(lead)) && <Person name={lead.assignee} />}
                    {canEditLead(state, lead.id) && (
                      <Select
                        aria-label={"Move " + lead.name + " to stage"}
                        value={lead.stage}
                        onChange={event => dispatch({ type: "UPDATE_LEAD", id: lead.id, change: { stage: event.target.value } })}
                      >
                        {LEAD_STAGES.map(item => (
                          <option key={item}>{item}</option>
                        ))}
                      </Select>
                    )}
                  </article>
                ))}
              {!leads.some(lead => lead.stage === column) && <p className="column-empty">No leads here</p>}
              {leads.filter(lead => lead.stage === column).length > (boardShown[column] || BOARD_STEP) && (
                <Button onClick={() => setBoardShown({ ...boardShown, [column]: (boardShown[column] || BOARD_STEP) + BOARD_STEP })}>
                  Show more ({(leads.filter(lead => lead.stage === column).length - (boardShown[column] || BOARD_STEP)).toLocaleString()} left)
                </Button>
              )}
            </BoardColumn>
          ))}
          {drag && (
            <div className="kanban-ghost" style={{ width: drag.width, transform: `translate(${drag.x}px, ${drag.y}px)` }}>
              <strong>{drag.label}</strong>
              <span>{drag.address}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="card table-card">
          <DataTable
            view={table}
            rowKey={lead => lead.id}
            leading={
              editable && {
                className: "checkbox-cell",
                head: (
                  <input
                    type="checkbox"
                    aria-label="Select all editable visible leads"
                    checked={
                      table.rows.some(lead => canEditLead(state, lead.id)) &&
                      table.rows.filter(lead => canEditLead(state, lead.id)).every(lead => selected.includes(lead.id))
                    }
                    onChange={event => setSelected(event.target.checked ? table.rows.filter(lead => canEditLead(state, lead.id)).map(lead => lead.id) : [])}
                  />
                ),
                cell: lead => (
                  <input
                    type="checkbox"
                    aria-label={"Select " + lead.name}
                    disabled={!canEditLead(state, lead.id)}
                    checked={selected.includes(lead.id)}
                    onChange={event => setSelected(event.target.checked ? [...selected, lead.id] : selected.filter(id => id !== lead.id))}
                  />
                ),
              }
            }
            columns={[
              {
                id: "owner",
                label: "Property owner",
                cell: lead => (
                  <button className="lead-link" onClick={() => navigate("work/leads/" + lead.id)}>
                    <strong>{lead.name}</strong>
                    <small>{lead.source}</small>
                  </button>
                ),
              },
              {
                id: "property",
                label: "Property",
                cell: lead => (
                  <>
                    <span>{lead.address}</span>
                    <small>
                      {lead.city}, {lead.region} {lead.zip}
                    </small>
                  </>
                ),
              },
              ...(!client && hasColumn.verdict ? [{ id: "verdict", label: "Phone quality", cell: lead => <Status value={lead.verdict} /> }] : []),
              { id: "stage", label: "Stage", cell: lead => <Status value={lead.stage} /> },
              ...(!client && hasColumn.assignee ? [{ id: "assignee", label: "Responsible person", cell: lead => <Person name={lead.assignee} link /> }] : []),
              ...(hasColumn.next
                ? [
                    {
                      id: "next",
                      label: "Next step",
                      cell: lead =>
                        client ? (
                          "Review property brief"
                        ) : lead.callback ? (
                          <span className="inline">
                            <Clock size={14} />
                            {callbackLabel(lead.callbackDate, lead.callback)}
                          </span>
                        ) : (
                          <span className="muted">Set a next step</span>
                        ),
                    },
                  ]
                : []),
            ]}
            trailing={{
              head: <span className="sr-only">Open</span>,
              cell: lead => <RoundButton label={"Open " + lead.name} onClick={() => navigate("work/leads/" + lead.id)} />,
            }}
          />
          {!table.rows.length && <Empty title="No leads match this view">Try another stage or search term.</Empty>}
          <footer className="table-footer">
            <span>{ROLES[state.role].scope}</span>
            <span>{leads.length} records · sample workspace</span>
          </footer>
        </div>
      )}
    </>
  );
}

const months = total => {
  const years = Math.floor(total / 12),
    rest = total % 12;
  return [years && years + (years === 1 ? " year" : " years"), rest && rest + (rest === 1 ? " month" : " months")].filter(Boolean).join(" ") || "Under a month";
};
const yesNo = value =>
  /^(?:y|yes|true|1)$/i.test(String(value).trim()) ? "Yes" : /^(?:n|no|false|0)$/i.test(String(value).trim()) ? "No" : String(value ?? "").trim();

/** The property and its owners as the source list describes them. Empty fields hide with "Hide empty fields". */
function PropertyRecord({ lead, hideEmpty }) {
  const lot = [lead.lotAcres != null && Number(lead.lotAcres.toFixed(3)) + " acres", lead.lotSqft != null && lead.lotSqft.toLocaleString() + " sq ft"]
    .filter(Boolean)
    .join(" · ");
  const garage = [lead.garageType, lead.garageSqft ? lead.garageSqft.toLocaleString() + " sq ft" : ""].filter(Boolean).join(" · ");
  const carport = [lead.carport, lead.carportSqft ? lead.carportSqft.toLocaleString() + " sq ft" : ""].filter(Boolean).join(" · ");
  const sections = [
    [
      "Owners",
      [
        [lead.owners?.length > 1 ? "Names" : "Name", (lead.owners?.length ? lead.owners : [lead.name]).join(" · ")],
        ["Mailing address", lead.mailing],
        ["Owner type", lead.ownerType],
        ["Owner occupied", yesNo(lead.ownerOccupied ?? "")],
        ["Vacant", yesNo(lead.vacant ?? "")],
        ["Owned for", lead.ownershipMonths != null ? months(lead.ownershipMonths) : ""],
      ],
    ],
    [
      "Property",
      [
        ["Property type", lead.propertyType],
        ["Property use", lead.propertyUse],
        ["Land use", lead.landUse],
        ["Living area", lead.area != null ? lead.area.toLocaleString() + " sq ft" : ""],
        ["Bedrooms / bathrooms", [lead.beds, lead.baths].some(v => v != null) ? (lead.beds ?? "—") + " / " + (lead.baths ?? "—") : ""],
        ["Year built", lead.yearBuilt ?? ""],
        ["Lot", lot],
        ["Units", lead.units ?? ""],
        ["Stories", lead.stories ?? ""],
        ["Garage", garage],
        ["Carport", carport],
        ["Air conditioning", lead.cooling],
        ["Heating", lead.heating],
        ["Fireplaces", lead.fireplaces ?? ""],
      ],
    ],
    [
      "Records",
      [
        ["County", lead.county],
        ["Parcel / APN", lead.parcel],
        ["Subdivision", lead.subdivision],
        ["Legal description", lead.legal],
        ["Record ID in the source", lead.sourceId],
      ],
    ],
  ];
  return (
    <Card title="Property & owners" subtitle="From the source list. Empty means the list did not include it.">
      {sections.map(([title, fields]) => {
        const shown = fields.filter(([, value]) => !hideEmpty || String(value ?? "").trim());
        if (!shown.length) return null;
        return (
          <section key={title} className="record-section">
            <h3>{title}</h3>
            <div className="detail-fields">
              {shown.map(([label, value]) => (
                <div key={label}>
                  <small>{label}</small>
                  <span>{String(value ?? "").trim() || <span className="muted">Not in this list</span>}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </Card>
  );
}

export function LeadDetail({ id }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const lead = scopedLeads(state).find(item => item.id === id);
  const [tab, setTab] = useState("Overview");
  const [note, setNote] = useState("");
  const [visibility, setVisibility] = useState("internal");
  const [handoff, setHandoff] = useState(false);
  const [recipient, setRecipient] = useState("Alex Rivera");
  const [handoffNote, setHandoffNote] = useState("");
  const [document, setDocument] = useState(false);
  const [newDeal, setNewDeal] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [editingNote, setEditingNote] = useState(null);
  const [hideEmpty, setHideEmpty] = useState(false);
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
  const leadDeals = state.deals.filter(deal => deal.leadId === id);
  return (
    <>
      <Breadcrumb items={[{ label: client ? "Shared properties" : "Leads", path: "work/leads" }, { label: lead.name }]} />
      <PageHeader title={lead.name} description={lead.address + " · " + lead.city}>
        {pending && <Badge tone="peach">Pending sync</Badge>}
        {lead.archived && <Badge tone="danger">Archived</Badge>}
        {lead.archived && editable ? (
          <Button
            variant="primary"
            onClick={() => {
              dispatch({ type: "RESTORE_LEAD", id });
              notify("Lead restored");
            }}
          >
            Restore lead
          </Button>
        ) : (
          capability(state, "call") && (
            <Button variant="primary" icon={Phone} disabled={lead.verdict === "Do not call"} onClick={() => navigate("work/calls/" + id)}>
              Call
            </Button>
          )
        )}
        {!lead.archived && capability(state, "edit") && (
          <Button icon={Plus} onClick={() => navigate("work/tasks/new?lead=" + id)}>
            Add task
          </Button>
        )}
        {!client && (
          <MoreMenu
            items={[
              {
                label: "Request handoff",
                icon: Handshake,
                hidden: lead.archived || !editable || !capability(state, "handoff"),
                onClick: () => {
                  setHandoffNote(lead.motivation);
                  setHandoff(true);
                },
              },
              { label: "Open conversation", icon: Envelope, hidden: !capability(state, "message"), onClick: () => navigate("work/inbox?lead=" + id) },
              {
                label: "Archive lead",
                icon: Archive,
                hidden: lead.archived || !editable,
                onClick: () => {
                  dispatch({ type: "ARCHIVE_LEAD", id });
                  notify(lead.name + " archived", { undo: () => dispatch({ type: "RESTORE_LEAD", id }) });
                  navigate("work/leads");
                },
              },
              {
                label: "Delete permanently",
                danger: true,
                hidden: !lead.archived || !editable || (state.remote && !capability(state, "assign")),
                onClick: () => setConfirm("delete"),
              },
            ]}
          />
        )}
      </PageHeader>
      <div className="detail-grid">
        <div>
          <div className="card property-detail">
            <div className="detail-photo">
              <img src="/assets/property.jpg" alt="Illustrative sample Florida house" />
              <span className="image-caption demo-note">Illustrative sample photo</span>
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
                {propertyFacts(lead).map(fact => (
                  <span key={fact}>{fact}</span>
                ))}
              </div>
              {capability(state, "finance") && (
                <div className="property-value">
                  <small>Estimated property value</small>
                  {lead.value == null ? <strong className="muted">Not in this list</strong> : <strong>{money(lead.value)}</strong>}
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
              options={client ? ["Overview", "Location", "Documents"] : ["Overview", "Activity", "Location", "Documents", "Evidence"]}
            />
          </div>
          {tab === "Location" && <PropertyMap rows={[lead]} title="Property location" compact />}
          {tab === "Overview" && (
            <>
              <Card title={client ? "Approved property context" : "The conversation so far"}>
                <p className="body-copy">
                  {client
                    ? "Your team has shared this property for review. Use the approved brief below and ask questions in the shared notes."
                    : lead.motivation}
                </p>
                {!client && <Checkbox label="Hide empty fields" checked={hideEmpty} onChange={event => setHideEmpty(event.target.checked)} />}
                {!client && (
                  <div className="detail-fields">
                    {!(hideEmpty && !lead.email) && (
                      <div>
                        <small>Email</small>
                        <span>{lead.email || <span className="muted">Not provided</span>}</span>
                      </div>
                    )}
                    {!(hideEmpty && !lead.phone) && (
                      <div>
                        <small>Best phone</small>
                        <span>{lead.phone || <span className="muted">Not provided</span>}</span>
                      </div>
                    )}
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
              {!client && lead.sourceValues && <PropertyRecord lead={lead} hideEmpty={hideEmpty} />}
              <Card
                title={client ? "Shared notes" : "Notes & context"}
                subtitle={client ? "Visible to you and the project team." : "Keep important details attached to the lead."}
              >
                {notes.map(item => {
                  const mine = item.actor === ROLES[state.role].person;
                  const manage = !client && (mine || editable);
                  return (
                    <article className="note" key={item.id}>
                      {editingNote?.id === item.id ? (
                        <form
                          className="note-edit"
                          onSubmit={event => {
                            event.preventDefault();
                            dispatch({ type: "EDIT_NOTE", leadId: id, noteId: item.id, text: editingNote.text });
                            setEditingNote(null);
                            notify("Note updated");
                          }}
                        >
                          <textarea
                            aria-label="Edit note"
                            value={editingNote.text}
                            onChange={event => setEditingNote({ ...editingNote, text: event.target.value })}
                            required
                            autoFocus
                          />
                          <div className="row">
                            <button className="button primary" type="submit">
                              Save
                            </button>
                            <Button onClick={() => setEditingNote(null)}>Cancel</Button>
                          </div>
                        </form>
                      ) : (
                        <p>
                          {item.text}
                          {item.edited && <small className="note-edited"> · edited</small>}
                        </p>
                      )}
                      <div>
                        <small>
                          {item.actor} · {item.at}
                        </small>
                        <Badge>{item.visibility === "shared" ? "Shared with partner" : "Internal"}</Badge>
                        {manage && editingNote?.id !== item.id && (
                          <span className="note-tools">
                            <button type="button" onClick={() => setEditingNote({ id: item.id, text: item.text })}>
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const index = lead.notes.findIndex(entry => entry.id === item.id);
                                dispatch({ type: "DELETE_NOTE", leadId: id, noteId: item.id });
                                notify("Note deleted", { undo: () => dispatch({ type: "RESTORE_NOTE", leadId: id, note: item, index }) });
                              }}
                            >
                              Delete
                            </button>
                          </span>
                        )}
                      </div>
                    </article>
                  );
                })}
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
                        <Select aria-label="Note visibility" value={visibility} onChange={event => setVisibility(event.target.value)}>
                          <option value="internal">Internal note</option>
                          {lead.shared && <option value="shared">Shared with partner</option>}
                        </Select>
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
          {tab === "Evidence" && !client && lead.sourceValues && (
            <Card title="Original source row" subtitle="Every column exactly as imported. CRM changes never edit it.">
              <div className="detail-fields source-row">
                {Object.entries(lead.sourceValues)
                  .filter(([, value]) => !hideEmpty || String(value ?? "").trim())
                  .map(([column, value]) => (
                    <div key={column}>
                      <small>{column}</small>
                      <span>{String(value ?? "").trim() || <span className="muted">Empty</span>}</span>
                    </div>
                  ))}
              </div>
            </Card>
          )}
        </div>
        <aside className="detail-aside">
          <Card title="Next step">
            {!client && (
              <>
                <Field label="Lead stage">
                  <Select
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
                  </Select>
                </Field>
                <Field label="Callback date">
                  <DatePicker
                    aria-label="Callback date"
                    min={TODAY}
                    disabled={!editable}
                    value={lead.callbackDate || ""}
                    onChange={event =>
                      dispatch({
                        type: "UPDATE_LEAD",
                        id,
                        change: { callbackDate: event.target.value, callback: event.target.value ? lead.callback || "10:00" : "" },
                      })
                    }
                  />
                </Field>
                <Field label="Callback time">
                  <TimePicker
                    aria-label="Callback time"
                    disabled={!editable}
                    value={lead.callback}
                    onChange={event =>
                      dispatch({
                        type: "UPDATE_LEAD",
                        id,
                        change: { callback: event.target.value, callbackDate: event.target.value ? lead.callbackDate || TODAY : "" },
                      })
                    }
                  />
                </Field>
                {capability(state, "assign") && (
                  <Field label="Responsible person" help={!state.online ? "Assignment needs an online connection." : "Changes follow the lead across lists."}>
                    <Select
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
                    </Select>
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
            <div className="row">
              {capability(state, "edit") && <Button onClick={() => navigate("work/tasks/new?lead=" + id)}>Add a next step</Button>}
              <Button onClick={() => navigate("work/tasks?lead=" + id)}>
                All tasks <ArrowUpRight size={15} />
              </Button>
            </div>
          </Card>
          {!client && capability(state, "finance") && (
            <Card title="Deals" subtitle="Each transaction is tracked on its own.">
              {leadDeals.map(deal => (
                <button type="button" className="deal-row" key={deal.id} onClick={() => navigate("work/deals/" + deal.id)}>
                  <div>
                    <strong>{money(deal.amount)}</strong>
                    <small>Close by {deal.closeDate}</small>
                  </div>
                  <Badge>{deal.stage}</Badge>
                </button>
              ))}
              {!leadDeals.length && <p className="muted">No deal opened for this property yet.</p>}
              {editable && !(state.remote && leadDeals.length) && (
                <Button icon={Plus} onClick={() => setNewDeal(true)}>
                  Open a deal
                </Button>
              )}
            </Card>
          )}
          {!client && (
            <Card title="Contact">
              <div className="contact-line">
                <Phone size={18} />
                {capability(state, "call") && lead.phone ? (
                  <button type="button" className="text-link" onClick={() => navigate("work/calls/" + id)} title="Open this lead in the call workspace">
                    {lead.phone}
                  </button>
                ) : (
                  <span>{lead.phone || "No phone supplied"}</span>
                )}
              </div>
              <div className="contact-line">
                <Envelope size={18} />
                {capability(state, "message") && lead.email ? (
                  <button type="button" className="text-link" onClick={() => navigate("work/inbox?lead=" + id)} title="Open the conversation">
                    {lead.email}
                  </button>
                ) : (
                  <span>{lead.email || "No email supplied"}</span>
                )}
              </div>
              {capability(state, "message") && <Button onClick={() => navigate("work/inbox?lead=" + id)}>Open conversation</Button>}
              <Status value={lead.verdict} />
            </Card>
          )}
          <Card title={client ? "Shared by your team" : "Source & ownership"}>
            <p className="body-copy">
              {client ? (
                "Oak & Palm Partners has approved this property for your review."
              ) : lead.datasetId && state.datasets.some(item => item.id === lead.datasetId) ? (
                <button type="button" className="text-link" onClick={() => navigate("lists/" + lead.datasetId)}>
                  {state.datasets.find(item => item.id === lead.datasetId).name} <ArrowUpRight size={13} />
                </button>
              ) : (
                "Added manually"
              )}
            </p>
            {!client && <Person name={lead.assignee} link />}
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
              <Select aria-label="Handoff recipient" value={recipient} onChange={event => setRecipient(event.target.value)}>
                {PEOPLE.filter(name => name !== ROLES[state.role].person).map(name => (
                  <option key={name}>{name}</option>
                ))}
              </Select>
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
      {newDeal && <NewDealModal lead={lead} onClose={() => setNewDeal(false)} />}
      {confirm === "delete" && (
        <ConfirmDialog
          title="Delete this lead for good?"
          confirmLabel="Delete permanently"
          danger
          onClose={() => setConfirm("")}
          onConfirm={() => {
            dispatch({ type: "DELETE_LEAD", id });
            setConfirm("");
            notify("Lead deleted");
            navigate("work/leads");
          }}
        >
          <p>
            {state.remote
              ? lead.name + " is removed from every list for everyone on the team. The server keeps a record of it in its audit trail."
              : "This removes " + lead.name + " together with their notes, deals, tasks, conversations and history. It cannot be undone."}
          </p>
        </ConfirmDialog>
      )}
      {document && (
        <Modal title="Approved property brief" onClose={() => setDocument(false)}>
          <article className="property-brief">
            <Badge tone="good">Shared property summary</Badge>
            <h3>{lead.address}</h3>
            <p>
              {lead.city}, {lead.region} {lead.zip}
            </p>
            <p>{propertyFacts(lead).join(" · ") || "Property details not supplied"}</p>
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
      <PageHeader title="New lead" description="The person, the property and who looks after it." />
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
            <Select name="assignee" defaultValue={ROLES[state.role].person}>
              {(capability(state, "assign") ? [...PEOPLE, "Unassigned"] : [ROLES[state.role].person]).map(name => (
                <option key={name}>{name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Callback time">
            <TimePicker name="callback" aria-label="Callback time" />
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
