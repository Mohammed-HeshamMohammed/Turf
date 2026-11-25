import { useEffect, useMemo, useRef, useState } from "react";
import { PropertyMap } from "./PropertyMap.jsx";
import { LeadsMap } from "./LeadsMap.jsx";
import { coordinates } from "./skiptrace-fields.ts";
import { Archive, ArrowUpRight, ArrowLeft, Plus, Phone, Envelope, Handshake, Clock, FileText, CheckCircle, Export, HouseLine } from "@phosphor-icons/react";
import { LEAD_STAGES, ROLES, TODAY } from "./data.ts";
import { AssignLeadsDialog } from "./AssignLeads.jsx";
import { archivedLeads, callbackLabel, canEditLead, capability, scopedLeads, uid, visibleLeads, teamNames, assignableNames } from "./model.ts";
import { CallHistory, NewDealModal } from "./Work.jsx";
import { useCrm } from "./context.jsx";
import { SkeletonRows } from "./Skeleton.jsx";
import { useLeadDetails, useLeadPage } from "./useLeadPage.js";
import { leadSource } from "./lead-source.ts";
import { STEP_TYPES, nextStepOf } from "./next-step.ts";
import { api } from "./remote/api.ts";
import { phoneHistory } from "./phone-history.ts";
import {
  Badge,
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
  tidyCase,
  formatPhone,
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
  const [assigning, setAssigning] = useState(false);
  const canAssign = Boolean(state.remote) && capability(state, "assign");
  const assigneeParam = new URLSearchParams(route.split("?")[1]).get("assignee") || "All people";
  const [assignee, setAssignee] = useState(assigneeParam);
  useEffect(() => setAssignee(assigneeParam), [assigneeParam]);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const client = state.role === "client";
  // A big workspace sends this device a window of its leads: searching asks the server for the rest.
  const heldAll = !state.remote || !(state.leadsTotal > state.leads.length);
  // A workspace bigger than this device's window of it: the list pages through the server, a page at a time.
  // If the server cannot page (an older version), the list falls back to the window this device holds.
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(10);
  const [serverFailed, setServerFailed] = useState(false);
  const serverMode = Boolean(state.remote) && !heldAll && !serverFailed;
  // One shared source answers (and remembers) each page, so coming back here, or opening it from another screen, is instant.
  // The server filters by the person's id ("unassigned" for nobody's leads) and only within what this person may see.
  const assigneeId = assignee === "All people" ? "" : assignee === "Unassigned" ? "unassigned" : (state.remote?.people || []).find(person => person.name === assignee)?.id || "";
  const found = useLeadPage({ term, stage: stage === "All stages" ? "" : stage, assignee: assigneeId, sort: "newest", offset: page * size, limit: size }, serverMode);
  const served = { ids: found.ids, total: found.total ?? 0 };
  const waiting = found.waiting; // the server has not answered for this page yet: not "no leads"
  useEffect(() => {
    if (found.failed) setServerFailed(true);
  }, [found.failed]);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim().length >= 2 ? search.trim() : ""), 350);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => setPage(0), [term, stage, assigneeId, size]);
  const byId = useMemo(() => new Map(state.leads.map(lead => [lead.id, lead])), [state.leads]);
  const archivedCount = archivedLeads(state).length;
  const windowLeads = (showArchived && archivedCount ? archivedLeads(state) : visibleLeads(state)).filter(
    lead =>
      (stage === "All stages" || lead.stage === stage) &&
      (assignee === "All people" || lead.assignee === assignee) &&
      [lead.name, lead.address, lead.city, ...(client ? [] : [lead.phone, lead.email])].join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  // Newest first, so an import's leads show at the top as each batch is added (the table's own sorting still applies on top).
  const newestFirst = useMemo(() => [...windowLeads].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))), [windowLeads]);
  const leads = serverMode ? served.ids.map(id => byId.get(id)).filter(Boolean) : newestFirst;
  // Refresh: the newest records now, and again every 15 seconds while the page is open and visible (when "Auto refresh" is on).
  const [autoRefresh, setAutoRefresh] = useState(() => {
    try {
      return window.localStorage.getItem("callerwhale.leads.autoRefresh") !== "off";
    } catch {
      return true;
    }
  });
  const [refreshedAt, setRefreshedAt] = useState(() => new Date());
  const refresh = () => {
    if (!state.remote) return;
    dispatch({ type: "SYNC" });
    leadSource.invalidate();
    setRefreshedAt(new Date());
  };
  useEffect(() => {
    if (!state.remote || !autoRefresh) return;
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [Boolean(state.remote), autoRefresh]); // eslint-disable-line react-hooks/exhaustive-deps
  // The spinner: a search typed and not yet sent, or sent and not yet answered.
  const searching = Boolean(state.remote) && ((search.trim().length >= 2 && search.trim() !== term) || (Boolean(term) && found.loading));
  const editable = capability(state, "edit");
  // The window's width decides how many details each row carries.
  const card = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    window.addEventListener("resize", measure);
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    watch?.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      watch?.disconnect();
    };
  }, [view]);
  const assigned = lead => lead.assignee && lead.assignee !== "Unassigned";
  const hasColumn = {
    verdict: !hideEmpty || leads.some(lead => lead.verdict),
    assignee: !hideEmpty || leads.some(assigned),
    next: true,
    phone: !client && width >= 1050 && (!hideEmpty || leads.some(lead => lead.phone)),
    email: !client && width >= 1250 && (!hideEmpty || leads.some(lead => lead.email)),
    value: !client && width >= 1450 && (!hideEmpty || leads.some(lead => lead.value)),
    priority: !client && width >= 1650,
  };
  // A value that is the same on every row says nothing new on each one, so it is shown quietly (or once): the signal is in what differs.
  const uniform = pick => leads.length > 1 && leads.every(lead => pick(lead) === pick(leads[0]));
  const sameSource = uniform(lead => lead.source);
  const sameAssignee = uniform(lead => lead.assignee);
  const table = useTableView(
    leads,
    {
      owner: { value: lead => lead.name },
      property: { value: lead => lead.address },
      verdict: { value: lead => lead.verdict || "" },
      stage: { value: lead => LEAD_STAGES.indexOf(lead.stage) },
      assignee: { value: lead => lead.assignee || "" },
      phone: { value: lead => lead.phone || "" },
      email: { value: lead => lead.email || "" },
      value: { value: lead => lead.value || 0 },
      priority: { value: lead => lead.priority || "" },
      next: { value: lead => (lead.callback ? (lead.callbackDate || "") + " " + lead.callback : "￿") },
    },
    "leads",
  );
  function exportRows() {
    downloadCsv("callerwhale-visible-leads.csv", [
      ["Owner", "Property", "City", "Stage", "Assigned to"],
      ...leads.map(lead => [lead.name, lead.address, lead.city, lead.stage, lead.assignee]),
    ]);
    notify("Visible leads exported");
  }
  return (
    <>
      {/* The page's name is already in the sidebar and the tab, so it is kept for screen readers only. */}
      <h1 className="sr-only">{client ? "Shared properties" : "Leads"}</h1>
      <div className="filter-bar">
        <div className="search-with-state">
          <Search value={search} onChange={setSearch} placeholder={client ? "Search shared properties" : "Search owner, property, or phone"} />
          {searching && <span className="spinner search-spinner" role="status" aria-label="Searching" />}
        </div>
        {!client && (
          <>
            <Select aria-label="Filter by lead stage" value={stage} onChange={event => setStage(event.target.value)}>
              <option>All stages</option>
              {LEAD_STAGES.map(item => (
                <option key={item}>{item}</option>
              ))}
            </Select>
            {(
              <Select aria-label="Filter by assigned person" value={assignee} onChange={event => setAssignee(event.target.value)}>
                <option>All people</option>
                {[...teamNames(state), "Unassigned"].map(item => (
                  <option key={item}>{item}</option>
                ))}
              </Select>
            )}
          </>
        )}
        <Segmented label="Lead view" value={view} options={["List", "Map"]} onChange={setView} />
        <Checkbox label="Hide empty fields" checked={hideEmpty} onChange={event => setHideEmpty(event.target.checked)} />
        {!client && !serverMode && archivedCount > 0 && (
          <Checkbox label={"Archived (" + archivedCount + ")"} checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />
        )}
        {state.remote && (
          <div className="refresh-controls">
            <Button onClick={refresh} title={"Updated " + refreshedAt.toLocaleTimeString()}>
              Refresh
            </Button>
            <Checkbox
              label="Auto refresh"
              checked={autoRefresh}
              onChange={event => {
                setAutoRefresh(event.target.checked);
                try {
                  window.localStorage.setItem("callerwhale.leads.autoRefresh", event.target.checked ? "on" : "off");
                } catch {
                  /* kept for this visit only */
                }
              }}
            />
          </div>
        )}
        {(capability(state, "export") || editable) && (
          <div className="filter-actions">
            {capability(state, "export") && (
              <Button icon={Export} onClick={exportRows}>
                Export view
              </Button>
            )}
            {canAssign && (
              <Button onClick={() => setAssigning(true)}>
                Give leads
              </Button>
            )}
            {editable && (
              <Button variant="primary" icon={Plus} onClick={() => navigate("work/leads/new")}>
                New lead
              </Button>
            )}
          </div>
        )}
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
          {canAssign && (
            <Button onClick={() => setAssigning(true)}>
              Give to…
            </Button>
          )}
          <button className="text-button" onClick={() => setSelected([])}>
            Clear selection
          </button>
        </div>
      )}
      {assigning && (
        <AssignLeadsDialog
          state={state}
          picked={selected}
          stage={stage === "All stages" ? "" : stage}
          notify={notify}
          onClose={() => {
            setAssigning(false);
            setSelected([]);
          }}
        />
      )}
      {view === "Map" ? (
        client ? (
          <PropertyMap rows={windowLeads} title="Shared property map" />
        ) : (
          <LeadsMap leads={windowLeads} total={state.remote ? state.leadsTotal : 0} />
        )
      ) : (
        <div className="card table-card" ref={card}>
          <DataTable
            paged
            remote={serverMode ? { total: served.total, page, onPage: setPage, onSize: setSize } : null}
            filler={{ loading: serverMode && waiting, empty: <span className="muted">No leads match this view. Try another stage or search term.</span> }}
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
                  <button className="lead-link" title={lead.source ? "From " + lead.source : undefined} onClick={event => { event.currentTarget.querySelector("strong").dataset.shared = "lead-title"; navigate("work/leads/" + lead.id); }}>
                    <strong>{tidyCase(lead.name)}</strong>
                    {!sameSource && lead.source && <small>{lead.source}</small>}
                  </button>
                ),
              },
              {
                id: "property",
                label: "Property",
                cell: lead => (
                  <>
                    <span>{tidyCase(lead.address)}</span>
                    <small>
                      {tidyCase(lead.city)}, {lead.region} {lead.zip}
                    </small>
                  </>
                ),
              },
              ...(hasColumn.phone ? [{ id: "phone", label: "Phone", cell: lead => formatPhone(lead.phone) || <span className="muted">—</span> }] : []),
              ...(hasColumn.email ? [{ id: "email", label: "Email", cell: lead => lead.email || <span className="muted">—</span> }] : []),
              ...(hasColumn.value ? [{ id: "value", label: "Value", className: "num", cell: lead => (lead.value ? money(lead.value) : <span className="muted">—</span>) }] : []),
              ...(hasColumn.priority ? [{ id: "priority", label: "Priority", cell: lead => lead.priority }] : []),
              ...(!client && hasColumn.verdict ? [{ id: "verdict", label: "Phone quality", cell: lead => (lead.verdict === "Unverified" ? <span className="quiet-value">{lead.verdict}</span> : <Status value={lead.verdict} />) }] : []),
              { id: "stage", label: "Stage", cell: lead => (lead.stage === "New" ? <span className="quiet-value">New</span> : <Status value={lead.stage} />) },
              ...(!client && hasColumn.assignee ? [{ id: "assignee", label: "Responsible person", cell: lead => (sameAssignee ? <Person name={lead.assignee} compact /> : <Person name={lead.assignee} link />) }] : []),
              ...(hasColumn.next
                ? [
                    {
                      id: "next",
                      label: "Next step",
                      cell: lead => <NextStepCell step={nextStepOf(lead, state.tasks)} client={client} />,
                    },
                  ]
                : []),
            ]}
            onRowClick={lead => navigate("work/leads/" + lead.id)}
            trailing={{
              head: <span className="sr-only">Open</span>,
              cell: lead => <RoundButton label={"Open " + lead.name} onClick={() => navigate("work/leads/" + lead.id)} />,
            }}
          />

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
  // A big workspace sends this device a window of its leads: the details of one outside it come when it is opened. A lead that is not on
  // this device at all (a fresh snapshot dropped it while its page was open) is asked for again before anything says it is out of view.
  // Connected, the details are always asked for once (they are kept): they also name the lead's co-owners.
  const fetching = useLeadDetails(id, Boolean(state.remote), !lead);
  const [askedOnce, setAskedOnce] = useState(false);
  useEffect(() => {
    if (fetching) setAskedOnce(true);
  }, [fetching]);
  const [tab, setTab] = useState("Overview");
  const [note, setNote] = useState("");
  const [visibility, setVisibility] = useState("internal");
  const [handoff, setHandoff] = useState(false);
  const [recipient, setRecipient] = useState("Alex Rivera");
  const [handoffNote, setHandoffNote] = useState("");
  const [newDeal, setNewDeal] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [editingNote, setEditingNote] = useState(null);
  const [hideEmpty, setHideEmpty] = useState(false);
  if (!lead && state.remote && (fetching || !askedOnce || state.remoteLoading))
    return <SkeletonRows rows={6} columns={2} />;
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
  const coOwners = fetching ? [] : leadSource.relatedOf(id);
  return (
    <>
      <Breadcrumb items={[{ label: client ? "Shared properties" : "Leads", path: "work/leads" }, { label: lead.name }]} />
      {coOwners.length > 0 && (
        <p className="co-owners">
          <Badge tone="info">Co-owners</Badge> Also at this property:{" "}
          {coOwners.map((other, index) => (
            <span key={other.id}>
              {index > 0 && ", "}
              <button type="button" className="text-link" onClick={() => navigate("work/leads/" + other.id)}>{other.name}</button>
            </span>
          ))}
        </p>
      )}
      <PageHeader title={lead.name} shared="lead-title" description={lead.address + " · " + lead.city}>
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
              <img src="/images/property.jpg" alt="Illustrative sample Florida house" />
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
                  // Connected: my note is one I wrote (by account), whatever my role; the demo compares the persona's name.
                  const mine = state.remote ? Boolean(item.authorId) && item.authorId === state.remote.user?.id : item.actor === ROLES[state.role].person;
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
          {tab === "Documents" && <LeadDocuments lead={lead} client={client} />}
          {tab === "Evidence" && !client && <PhoneHistory lead={lead} />}
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
                      {[...new Set([lead.assignee, ...assignableNames(state), "Unassigned"].filter(Boolean))].map(name => (
                        <option key={name}>{name}</option>
                      ))}
                    </Select>
                  </Field>
                )}
              </>
            )}
            <NextStepPanel lead={lead} tasks={tasks} client={client} />
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
                {lead.phoneType && <small className="muted">{lead.phoneType}</small>}
              </div>
              {(lead.otherPhones || []).map(item => (
                <div className="contact-line" key={item.number}>
                  <Phone size={18} />
                  <span>{item.number}</span>
                  <small className="muted">{item.type || "other phone"}</small>
                </div>
              ))}
              <div className="contact-line">
                <Envelope size={18} />
                {capability(state, "message") && lead.email ? (
                  <button type="button" className="text-link" onClick={() => navigate("work/mail?lead=" + id)} title="Email this lead">
                    {lead.email}
                  </button>
                ) : (
                  <span>{lead.email || "No email supplied"}</span>
                )}
              </div>
              {(lead.otherEmails || []).map(item => (
                <div className="contact-line" key={item}>
                  <Envelope size={18} />
                  <span>{item}</span>
                </div>
              ))}
              {(lead.owners || []).length > 1 && <p className="muted">Owners: {lead.owners.join(", ")}</p>}
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
                {teamNames(state).filter(name => name !== ROLES[state.role].person).map(name => (
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
            {"This removes " + lead.name + " from the CRM and its source list, together with related notes, deals, tasks, conversations and call history. It cannot be undone."}
          </p>
        </ConfirmDialog>
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
              {(capability(state, "assign") ? [...new Set([ROLES[state.role].person, ...assignableNames(state), "Unassigned"])] : [ROLES[state.role].person]).map(name => (
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

const dueLabel = step => (step.date ? callbackLabel(step.date, step.time) : "No date");

/** The Leads table's Next step: the lead's earliest open task or callback (red once overdue), or what its stage suggests. */
function NextStepCell({ step, client }) {
  if (!step || (client && step.kind === "suggested")) return <span className="muted">—</span>;
  if (step.kind === "suggested")
    return (
      <span className="next-suggested" title="Suggested from the lead's stage: open the lead to schedule it">
        Suggested: {step.title}
      </span>
    );
  return (
    <span className={"inline next-step" + (step.overdue ? " overdue" : "")} title={step.overdue ? "Overdue" : undefined}>
      <Clock size={14} />
      <span>
        {step.title} · {dueLabel(step)}
      </span>
    </span>
  );
}

/** A lead's next step and how to schedule another: a call, a text, an appointment or a follow-up, for a person, on a day and time.
 * It is a task, so it is on that person's tasks and calendar too. */
function NextStepPanel({ lead, tasks, client }) {
  const { state, dispatch, notify, navigate } = useCrm();
  const step = nextStepOf(lead, tasks);
  const me = state.remote ? state.remote.user?.name : ROLES[state.role].person;
  const canSchedule = !client && (capability(state, "edit") || capability(state, "review"));
  const people = capability(state, "assign") ? [...new Set([lead.assignee, me, ...assignableNames(state)].filter(name => name && name !== "Unassigned"))] : [me];
  const [form, setForm] = useState(null);
  const open = (type = "Call", title = "") =>
    setForm({ type, title, date: TODAY, time: "10:00", assignee: lead.assignee && people.includes(lead.assignee) ? lead.assignee : me });
  const later = tasks.filter(task => !task.done && task.id !== (step?.kind === "task" ? step.id : ""));
  return (
    <div className="next-step-panel">
      {step && step.kind !== "suggested" && (
        <div className={"next-step-now" + (step.overdue ? " overdue" : "")}>
          <Clock size={18} />
          <div>
            <strong>{step.title}</strong>
            <small>
              {step.overdue ? "Overdue · " : ""}
              {dueLabel(step)}
              {step.kind === "task" && step.assignee ? " · " + step.assignee : ""}
            </small>
          </div>
          {step.kind === "task" && canSchedule && (
            <Button
              onClick={() => {
                dispatch({ type: "TASK", id: step.id });
                notify("Step done");
              }}
            >
              Done
            </Button>
          )}
        </div>
      )}
      {step?.kind === "suggested" && !client && (
        <div className="next-step-now suggested">
          <div>
            <small>Suggested from the stage</small>
            <strong>{step.title}</strong>
          </div>
          {canSchedule && !form && <Button onClick={() => open(step.type, step.title)}>Schedule</Button>}
        </div>
      )}
      {(!step || (client && step.kind === "suggested")) && <p className="muted">{client ? "No shared actions waiting." : "Nothing scheduled."}</p>}
      {later.length > 0 && (
        <ul className="next-step-later">
          {later.map(task => (
            <li key={task.id}>
              {task.title} · {task.date ? callbackLabel(task.date, task.time) : "No date"}
            </li>
          ))}
        </ul>
      )}
      {form && (
        <form
          className="next-step-form"
          onSubmit={event => {
            event.preventDefault();
            dispatch({
              type: "TASK",
              task: { title: form.title.trim() || form.type + " · " + lead.name, leadId: lead.id, assignee: form.assignee, date: form.date, time: form.time, priority: "Normal", type: form.type },
            });
            notify("Next step scheduled");
            setForm(null);
          }}
        >
          <Field label="What">
            <Select aria-label="Step type" value={form.type} onChange={event => setForm({ ...form, type: event.target.value })}>
              {STEP_TYPES.map(type => (
                <option key={type}>{type}</option>
              ))}
            </Select>
          </Field>
          <Field label="Note (optional)">
            <input value={form.title} placeholder={form.type + " · " + lead.name} onChange={event => setForm({ ...form, title: event.target.value })} />
          </Field>
          <Field label="Day">
            <DatePicker aria-label="Step day" min={TODAY} value={form.date} onChange={event => setForm({ ...form, date: event.target.value })} />
          </Field>
          <Field label="Time">
            <TimePicker aria-label="Step time" value={form.time} onChange={event => setForm({ ...form, time: event.target.value })} />
          </Field>
          {people.length > 1 && (
            <Field label="Who">
              <Select aria-label="Who does it" value={form.assignee} onChange={event => setForm({ ...form, assignee: event.target.value })}>
                {people.map(name => (
                  <option key={name}>{name}</option>
                ))}
              </Select>
            </Field>
          )}
          <div className="row">
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={!form.date}>
              Schedule
            </Button>
          </div>
        </form>
      )}
      <div className="row">
        {canSchedule && !form && <Button onClick={() => open()}>Schedule a next step</Button>}
        <Button onClick={() => navigate("work/tasks?lead=" + lead.id)}>
          All tasks <ArrowUpRight size={15} />
        </Button>
      </div>
    </div>
  );
}

const fileSize = bytes => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB");

/** A lead's documents: files people uploaded (contracts, photos, statements), each internal or shared with the lead's clients, with
 * who added it and when; plus the list the lead came from. Files live in the CRM's server, up to 10 MB each. */
function LeadDocuments({ lead, client }) {
  const { state, notify, navigate } = useCrm();
  const remote = Boolean(state.remote);
  const [files, setFiles] = useState(null);
  const [canUpload, setCanUpload] = useState(false);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState("");
  const picker = useRef(null);
  const me = state.remote?.user?.id;
  const load = () =>
    api.files.list(lead.id).then(
      found => {
        setFiles(found.files || []);
        setCanUpload(Boolean(found.can_upload));
      },
      reason => setError(reason.message || "Files could not be loaded."),
    );
  useEffect(() => {
    if (remote) load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load the files when the lead changes; load is redefined each render
  }, [lead.id, remote]);
  const upload = async chosen => {
    const list = [...chosen];
    if (!list.length) return;
    const tooBig = list.find(file => file.size > 10 * 1048576);
    if (tooBig) return setError(tooBig.name + " is over 10 MB.");
    setBusy(true);
    setError("");
    try {
      for (const file of list) await api.files.upload(lead.id, file, shared ? "shared" : "internal");
      notify(list.length === 1 ? "File added" : list.length + " files added");
      await load();
    } catch (reason) {
      setError(reason.message || "The file could not be added.");
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  };
  const download = async file => {
    try {
      const blob = await api.files.download(file.id);
      const url = URL.createObjectURL(blob);
      const link = Object.assign(window.document.createElement("a"), { href: url, download: file.name });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(reason.message || "The file could not be downloaded.");
    }
  };
  const remove = async file => {
    if (removing !== file.id) return setRemoving(file.id);
    setRemoving("");
    try {
      await api.files.remove(file.id);
      notify("File removed");
      await load();
    } catch (reason) {
      setError(reason.message || "The file could not be removed.");
    }
  };
  const dataset = state.datasets.find(item => item.id === lead.datasetId);
  return (
    <Card title="Documents" subtitle={client ? "Files your team shared with you." : "Contracts, photos and other files for this property."}>
      {!remote && <p className="muted">Files are kept on the server: sign in to a workspace to add them.</p>}
      {remote && files === null && !error && <SkeletonRows rows={2} columns={3} />}
      {remote && files?.length === 0 && <p className="muted">{client ? "Nothing shared yet." : "No files yet."}</p>}
      {(files || []).map(file => (
        <div className="document-row" key={file.id}>
          <FileText size={32} weight="light" />
          <div>
            <strong>{file.name}</strong>
            <small>
              {fileSize(file.size)} · {file.uploaded_label || "Someone"} · {new Date(file.created_at).toLocaleString()}
            </small>
          </div>
          {!client && <Badge tone={file.visibility === "shared" ? "good" : ""}>{file.visibility === "shared" ? "Shared" : "Internal"}</Badge>}
          <Button onClick={() => download(file)}>Download</Button>
          {!client && (canUpload || file.uploaded_by === me) && (
            <Button variant={removing === file.id ? "danger-button" : ""} onClick={() => remove(file)}>
              {removing === file.id ? "Remove?" : "Remove"}
            </Button>
          )}
        </div>
      ))}
      {remote && canUpload && (
        <div className="document-upload">
          <input ref={picker} type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.doc,.docx,.xls,.xlsx" onChange={event => upload(event.target.files)} />
          <Button variant="primary" disabled={busy} onClick={() => picker.current?.click()}>
            {busy ? "Adding…" : "Add files"}
          </Button>
          <Checkbox checked={shared} onChange={event => setShared(event.target.checked)} label="Share with this lead's clients" />
          <small className="muted">PDF, images, text, Word or Excel, up to 10 MB each.</small>
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
      {!client && lead.datasetId && (
        <div className="document-row">
          <FileText size={32} weight="light" />
          <div>
            <strong>Source list</strong>
            <small>{dataset?.name || "Imported file"}</small>
          </div>
          <Badge>Internal</Badge>
          <Button onClick={() => navigate("lists/" + lead.datasetId)}>View source</Button>
        </div>
      )}
    </Card>
  );
}

/** The Evidence tab: each of the lead's phones, how many times it was called, the last result and where the number stands now. */
function PhoneHistory({ lead }) {
  const phones = phoneHistory(lead);
  return (
    <Card title="Phone history" subtitle="What calling each number has shown so far.">
      {!phones.length && <p className="muted">This lead has no phone number.</p>}
      {phones.length > 0 && (
        <div className="table-wrap">
          <table className="phone-history">
            <thead>
              <tr>
                <th scope="col">Phone</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Calls</th>
                <th scope="col">Last call</th>
              </tr>
            </thead>
            <tbody>
              {phones.map(phone => (
                <tr key={phone.number}>
                  <td>
                    <strong>{formatPhone(phone.number) || phone.number}</strong>
                    <small className="muted">
                      {[phone.primary ? "Main" : "", phone.type].filter(Boolean).join(" · ")}
                    </small>
                  </td>
                  <td>
                    <Badge tone={phone.tone}>{phone.status}</Badge>
                  </td>
                  <td className="num">{phone.calls}</td>
                  <td>
                    {phone.last ? (
                      <>
                        {phone.last.outcome}
                        <small className="muted">
                          {[phone.last.at ? new Date(phone.last.at).toLocaleString() : "", phone.last.agent].filter(Boolean).join(" · ")}
                        </small>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
