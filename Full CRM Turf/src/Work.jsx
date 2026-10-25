import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PropertyMap } from "./PropertyMap.jsx";
import {
  Phone,
  PhoneDisconnect,
  Play,
  Pause,
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
  ClosedCaptioning,
  PencilSimple,
  X,
} from "@phosphor-icons/react";
import { CALL_OUTCOMES, DEAL_STAGES, PEOPLE, ROLES, TODAY } from "./data.js";
import { callbackLabel, canEditLead, capability, uid, visibleLeads, visibleTasks, visibleThreads } from "./model.js";
import { useCrm } from "./context.jsx";
import { CallAssistant } from "./CallAssistant.jsx";
import { getCallSession, setCallSession, useCallSession } from "./callSession.js";
import {
  Badge,
  Select,
  Button,
  Card,
  Empty,
  Field,
  LeadLink,
  Modal,
  PageHeader,
  Person,
  RoundButton,
  Search,
  Segmented,
  DataTable,
  DatePicker,
  DateTimePicker,
  TimePicker,
  useTableView,
  Status,
  money,
  Breadcrumb,
  Checkbox,
  ConfirmDialog,
  usePresence,
} from "./ui.jsx";

export function Calls({ target }) {
  const { state, dispatch, navigate, notify, route } = useCrm();
  // A call in progress belongs to the app, not this page, so it carries on (with its captions) while you look around.
  const session = useCallSession();
  const activeCall = session.active;
  const callStatus = usePresence(activeCall, 320);
  const captions = session.captions;
  const [chosen, setChosen] = useState(target || (getCallSession().active ? getCallSession().lead?.id : "") || "");
  const [script, setScript] = useState("First conversation");
  const [recording, setRecording] = useState(false);
  const [callNote, setCallNote] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [askingCallback, setAskingCallback] = useState(false);
  const [detailTab, setDetailTab] = useState("History");
  const [autoDial, setAutoDial] = useState(false);
  const autoQueue = useRef([]);
  useEffect(() => {
    if (!state.online || !capability(state, "call")) {
      autoQueue.current = [];
      setAutoDial(false);
    }
  }, [state]);
  // The queue follows a list: the one chosen above it, or the one a list page sent you here with (?list=).
  const listParam = new URLSearchParams(route.split("?")[1]).get("list") || "";
  const [listId, setListId] = useState(listParam);
  useEffect(() => setListId(listParam), [listParam]);
  const toggleCaptions = (next = !captions) => setCallSession({ captions: next });
  const callable = useMemo(
    () => visibleLeads(state).filter(item => item.stage !== "Closed" && item.verdict !== "Do not call" && item.verdict !== "Wrong number"),
    [state],
  );
  const lists = useMemo(
    () =>
      [...new Set(callable.map(item => item.datasetId || ""))].map(id => ({
        id,
        name: state.datasets.find(item => item.id === id)?.name || "Direct leads",
        count: callable.filter(item => (item.datasetId || "") === id).length,
      })),
    [callable, state.datasets],
  );
  const activeList = lists.some(item => item.id === listId) ? listId : "";
  // Within a list, callbacks that are due come first, then people who have never been called.
  const leads = useMemo(() => {
    const due = item => (item.callback ? (item.callbackDate || "") + item.callback : "~");
    const order = item => String(lists.findIndex(entry => entry.id === (item.datasetId || ""))).padStart(3, "0") + due(item);
    return callable
      .filter(item => !activeList || (item.datasetId || "") === activeList)
      .map((item, index) => ({ item, index, key: order(item) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
      .map(entry => entry.item);
  }, [callable, activeList, lists]);
  const lead = leads.find(item => item.id === chosen) || leads[0];
  const autoEligible = leads.filter(item => item.phone?.trim() && canEditLead(state, item.id));
  const setActiveCall = (on, contact = lead) =>
    setCallSession({
      active: on,
      lead: on && contact ? { id: contact.id, name: contact.name, address: contact.address, motivation: contact.motivation } : null,
      transcript: [],
    });
  if (!capability(state, "call")) return <Empty title="Calling is outside this role">Your workspace only shows the actions available to you.</Empty>;
  function pauseAutoDial() {
    autoQueue.current = [];
    setAutoDial(false);
  }
  function toggleAutoDial() {
    if (autoDial) {
      pauseAutoDial();
      notify("Auto dial paused");
      return;
    }
    if (!state.online || !autoEligible.length) return;
    const position = Math.max(0, autoEligible.findIndex(item => item.id === lead?.id));
    const ordered = [...autoEligible.slice(position), ...autoEligible.slice(0, position)];
    const first = ordered[0];
    autoQueue.current = ordered.slice(1).map(item => item.id);
    setAutoDial(true);
    if (!activeCall) {
      setChosen(first.id);
      setActiveCall(true, first);
    }
    notify("Auto dial started · save each outcome to continue");
  }
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
    if (autoDial) {
      if (state.online && !["Transfer", "Callback"].includes(value)) {
        let next;
        while (autoQueue.current.length && !next) {
          const id = autoQueue.current.shift();
          next = autoEligible.find(item => item.id === id && item.id !== lead.id);
        }
        if (next) {
          setChosen(next.id);
          setActiveCall(true, next);
          notify(value + " recorded · calling " + next.name);
          return;
        }
        pauseAutoDial();
        notify(value + " recorded · Auto dial queue complete");
        return;
      }
      pauseAutoDial();
    }
    notify(state.online ? value + " recorded" : "Manual call outcome queued for sync");
    // A live conversation stays on screen for the next step; anything else moves to the next lead.
    if (!["Transfer", "Callback"].includes(value)) setChosen(leads[(leads.findIndex(item => item.id === lead.id) + 1) % leads.length]?.id || "");
  }
  const calls = [...(lead?.calls || [])].reverse();
  return (
    <>
      <div className="calls-heading">
        <PageHeader title="Calls">
          <Button
            icon={autoDial ? Pause : Play}
            variant="auto-dial-button"
            aria-pressed={autoDial}
            disabled={!autoDial && (!state.online || !autoEligible.length || (activeCall && !autoEligible.some(item => item.id === lead?.id)))}
            title="Run through this demo queue. Save an outcome to start the next call. Callbacks and transfers pause auto dial."
            onClick={toggleAutoDial}
          >
            {autoDial ? "Pause auto dial" : "Auto dial"}
          </Button>
        </PageHeader>
      </div>
      <div className="call-layout">
        <Card
          title="Your call queue"
          subtitle={
            leads.length +
            (leads.length === 1 ? " lead" : " leads") +
            (activeList ? " in " + (lists.find(item => item.id === activeList)?.name || "this list") : " across your lists")
          }
          className="queue-card"
        >
          {lists.length > 1 && (
            <div className="queue-list-pick">
              <Select aria-label="Call list" value={activeList} disabled={activeCall || autoDial} onChange={event => setListId(event.target.value)}>
                <option value="">{"All lists · " + callable.length}</option>
                {lists.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name + " · " + item.count}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {leads.map((item, position) => (
            <Fragment key={item.id}>
              {!activeList && lists.length > 1 && (position === 0 || (leads[position - 1].datasetId || "") !== (item.datasetId || "")) && (
                <div className="queue-group">{lists.find(entry => entry.id === (item.datasetId || ""))?.name}</div>
              )}
              <button
                className={"queue-lead " + (item.id === lead?.id ? "selected" : "")}
                disabled={(activeCall || autoDial) && item.id !== lead?.id}
                onClick={() => {
                  if (activeCall || autoDial) return;
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
                  <small className="muted">
                    {item.calls?.length
                      ? item.calls.length + (item.calls.length === 1 ? " call · " : " calls · ") + item.calls.at(-1).outcome
                      : "Not called yet"}
                  </small>
                </div>
              </button>
            </Fragment>
          ))}
          {!leads.length && <Empty title="No callable leads">Blocked and closed leads are left out.</Empty>}
        </Card>
        <div className="call-main">
          {lead ? (
            <>
              <Card className="call-person">
                <div className="row">
                  <Badge tone="good" className="demo-note">
                    Sample phone workspace
                  </Badge>
                  <Status value={lead.stage} />
                </div>
                <h2>{lead.name}</h2>
                <p>
                  {lead.address} · {lead.city}, {lead.region}
                </p>
                <div className="call-dial-row">
                  <div className="dial-number">{lead.phone}</div>
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
                </div>
                <div className={"call-status" + (activeCall ? " is-live" : "")}>
                  <div className="call-status-ready" aria-hidden={activeCall}>
                    <div className="call-status-inner">
                      <div className="row">
                        <Status value={lead.verdict} />
                        <span className="muted">Check calling permission before a real call</span>
                      </div>
                    </div>
                  </div>
                  <div className="call-status-live" aria-hidden={!activeCall}>
                    <div className="call-status-inner">
                      <div className="call-live" role="status">
                        <span className="call-live-label"><span className="status-dot" />Call in progress</span>
                        {callStatus.mounted && <CallTimer key={lead.id} />}
                        <span className="demo-note">Demo audio, no number is dialled</span>
                      </div>
                    </div>
                  </div>
                </div>
                {lead.motivation && <p className="body-copy">{lead.motivation}</p>}
                <div className="call-owner">
                  <small>Owner</small>
                  <Person name={lead.assignee} link />
                </div>
                {!state.online && <p className="notice">Calling needs a connection. You can record a manual outcome below.</p>}
                <div className="call-actions">
                  <Button onClick={() => navigate("work/leads/" + lead.id)}>Full lead record</Button>
                  <Button icon={ClosedCaptioning} aria-pressed={captions} variant={captions ? "is-on" : ""} onClick={() => toggleCaptions()}>
                    Live captions
                  </Button>
                </div>
              </Card>
              <Card
                className={"call-outcomes" + (activeCall ? " is-live" : "")}
                title="How did it go?"
                subtitle={
                  activeCall ? "Pick the outcome when you hang up. It is saved to the lead." : "Record an outcome, even for a call made outside the app."
                }
              >
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
                      <DateTimePicker
                        aria-label="Call back at"
                        min={TODAY + "T00:00"}
                        value={callbackAt}
                        onChange={event => setCallbackAt(event.target.value)}
                      />
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
                  <Checkbox label="Record demo session" checked={recording} onChange={event => setRecording(event.target.checked)} />
                </div>
                {recording && <small className="demo-note">Recording preview enabled. This prototype does not record microphone audio.</small>}
              </Card>
              <Card
                className="call-details"
                title="About this lead"
                action={<Segmented label="Lead details" value={detailTab} onChange={setDetailTab} options={["History", "Location"]} />}
              >
                {detailTab === "History" ? <CallHistoryList calls={calls} /> : <PropertyMap rows={[lead]} title="Call property location" compact />}
              </Card>
            </>
          ) : (
            <Empty title="Your queue is clear">Choose another role or add a lead to continue.</Empty>
          )}
        </div>
        <aside aria-label="Call assistant">
          <CallAssistant
            lead={lead}
            person={ROLES[state.role].person.split(" ")[0]}
            script={script}
            onScript={setScript}
            activeCall={activeCall}
            captions={captions}
            onCaptions={toggleCaptions}
            onUse={text => setCallNote(note => (note.trim() ? note.trimEnd() + "\n" : "") + "• " + text)}
          />
        </aside>
      </div>
    </>
  );
}

function callTime(at) {
  return at ? new Date(at + ":00Z").toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) : "";
}
/** How long the current call has been running, as m:ss. */
function CallTimer() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((now - start) / 1000);
  return <span className="call-timer">{Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")}</span>;
}

/** The call history rows on their own, for places that already have a card around them. */
function CallHistoryList({ calls }) {
  if (!calls.length) return <Empty title="Not called yet">Outcomes you record appear here with their time and next call.</Empty>;
  return calls.map(item => (
    <div className="call-entry" key={item.id}>
      <Badge tone={["Wrong number", "Do not call"].includes(item.outcome) ? "danger" : ["Transfer", "Callback"].includes(item.outcome) ? "good" : ""}>
        {item.code}
      </Badge>
      <div>
        <strong>{item.outcome}</strong>
        <small>
          {callTime(item.at)} · {item.agent}
          {item.scheduled ? " · next call " + callTime(item.scheduled) : ""}
        </small>
      </div>
    </div>
  ));
}

export function CallHistory({ calls }) {
  return (
    <Card
      title="Call history"
      subtitle={calls.length ? calls.length + (calls.length === 1 ? " call, newest first" : " calls, newest first") : "Every dialed call is kept here."}
    >
      {calls.map(item => (
        <div className="call-entry" key={item.id}>
          <Badge tone={["Wrong number", "Do not call"].includes(item.outcome) ? "danger" : ["Transfer", "Callback"].includes(item.outcome) ? "good" : ""}>
            {item.code}
          </Badge>
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
      <PageHeader title="Handoffs" description="Leads passed between people, waiting to be accepted or declined." />
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
                <Person name={item.from} link />
                <ArrowRight size={20} />
                <Person name={item.to} link />
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

/** Opens a deal for a lead. With a lead given it is fixed; otherwise you choose one that is yours to edit. */
export function NewDealModal({ lead, onClose }) {
  const { state, dispatch, navigate, notify } = useCrm();
  // Against a server each lead has one deal, so only leads without one can open another.
  const choices = visibleLeads(state).filter(
    item => item.stage !== "Closed" && canEditLead(state, item.id) && !(state.remote && state.deals.some(deal => deal.leadId === item.id)),
  );
  const [leadId, setLeadId] = useState(lead?.id || choices[0]?.id || "");
  return (
    <Modal title="Open a deal." onClose={onClose}>
      <p className="muted">A deal tracks one transaction, linked back to its lead and property.</p>
      <form
        onSubmit={event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const deal = {
            id: uid(),
            leadId,
            stage: String(form.get("stage")),
            amount: Math.max(0, Number(form.get("amount")) || 0),
            fee: Math.max(0, Number(form.get("fee")) || 0),
            closeDate: String(form.get("closeDate")),
          };
          dispatch({ type: "NEW_DEAL", deal });
          onClose();
          notify("Deal opened");
          navigate("work/deals/" + deal.id);
        }}
      >
        <Field label="Lead and property">
          {lead ? (
            <input value={lead.address + " · " + lead.name} readOnly />
          ) : (
            <Select aria-label="Lead for the deal" value={leadId} onChange={event => setLeadId(event.target.value)}>
              {choices.map(item => (
                <option key={item.id} value={item.id}>
                  {item.address + " · " + item.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="form-grid">
          <Field label="Deal stage">
            <Select name="stage" defaultValue={DEAL_STAGES[0]}>
              {DEAL_STAGES.map(stage => (
                <option key={stage}>{stage}</option>
              ))}
            </Select>
          </Field>
          <Field label="Target close date">
            <DatePicker name="closeDate" aria-label="Target close date" min={TODAY} defaultValue={TODAY} required />
          </Field>
          <Field label="Offer amount">
            <input name="amount" type="number" min="0" step="1000" placeholder="0" required />
          </Field>
          <Field label="Expected fee">
            <input name="fee" type="number" min="0" step="500" placeholder="0" />
          </Field>
        </div>
        <div className="row">
          <Button onClick={onClose}>Cancel</Button>
          <button className="button primary" type="submit" disabled={!leadId}>
            <Plus size={17} />
            Open deal
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Deals({ id }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const [view, setView] = useState("Pipeline");
  const [drag, setDrag] = useState(null);
  const justDragged = useRef(false);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState(false);
  const leads = visibleLeads(state);
  const ids = new Set(leads.map(item => item.id));
  const deals = state.deals.filter(item => ids.has(item.leadId));
  const table = useTableView(
    deals.map(deal => ({ deal, lead: leads.find(item => item.id === deal.leadId) })),
    {
      property: { value: row => row.lead.address },
      stage: { value: row => DEAL_STAGES.indexOf(row.deal.stage) },
      amount: { value: row => row.deal.amount },
      fee: { value: row => row.deal.fee },
      close: { value: row => row.deal.closeDate },
    },
    "deals",
  );
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
                <DatePicker
                  aria-label="Target close date"
                  value={deal.closeDate}
                  onChange={event => dispatch({ type: "DEAL", id, change: { closeDate: event.target.value } })}
                />
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
            <Person name={lead.assignee} link />
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
            {capability(state, "message") && <Button onClick={() => navigate("work/inbox?lead=" + lead.id)}>Open conversation</Button>}
            {canEditLead(state, lead.id) && capability(state, "finance") && (
              <Button variant="danger-button" onClick={() => setRemoving(true)}>
                Delete deal
              </Button>
            )}
          </Card>
        </div>
        {removing && (
          <ConfirmDialog
            title="Delete this deal?"
            confirmLabel="Delete deal"
            danger
            onClose={() => setRemoving(false)}
            onConfirm={() => {
              dispatch({ type: "DELETE_DEAL", id });
              setRemoving(false);
              notify("Deal deleted. The lead is untouched.");
              navigate("work/deals");
            }}
          >
            <p>
              The {money(deal.amount)} deal for {lead.address} is removed. {lead.name} stays as a lead, and nothing else changes.
            </p>
          </ConfirmDialog>
        )}
        <Card title="What has happened" subtitle="Everything recorded on this lead and its deal, newest first.">
          {state.activities
            .filter(item => item.leadId === lead.id)
            .slice(0, 8)
            .map(item => (
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
          {!state.activities.some(item => item.leadId === lead.id) && (
            <Empty title="Nothing yet">Stage changes, notes and calls appear here as they happen.</Empty>
          )}
          <Button onClick={() => navigate("work/leads/" + lead.id)}>Full lead history</Button>
        </Card>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Deals">
        {capability(state, "finance") && (!state.remote || leads.some(item => !deals.some(deal => deal.leadId === item.id))) && (
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            New deal
          </Button>
        )}
      </PageHeader>
      {creating && <NewDealModal onClose={() => setCreating(false)} />}
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
        <div className="kanban deal-board view-in">
          {DEAL_STAGES.map(stage => (
            <section key={stage} className={"kanban-column" + (drag?.over === stage ? " drop-target" : "")} data-stage={stage}>
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
        <Card className="table-card deals-list view-in">
          <DataTable
            view={table}
            rowKey={row => row.deal.id}
            columns={[
              { id: "property", label: "Property", cell: ({ lead }) => <LeadLink lead={lead} /> },
              {
                id: "stage",
                label: "Stage",
                cell: ({ deal }) => (
                  <span className="stage-pill" data-stage={deal.stage}>
                    {deal.stage}
                  </span>
                ),
              },
              { id: "amount", label: "Offer amount", className: "num", cell: ({ deal }) => money(deal.amount) },
              { id: "fee", label: "Expected fee", className: "num", cell: ({ deal }) => money(deal.fee) },
              { id: "close", label: "Target close", cell: ({ deal }) => shortDate(deal.closeDate) },
            ]}
            trailing={{
              head: <span className="sr-only">Open</span>,
              cell: ({ deal, lead }) => <RoundButton label={"Open deal for " + lead.name} onClick={() => navigate("work/deals/" + deal.id)} />,
            }}
          />
          <div className="list-footer">
            <span>
              {table.rows.length} {table.rows.length === 1 ? "deal" : "deals"}
            </span>
            <span>{money(table.rows.reduce((sum, row) => sum + row.deal.amount, 0))} in offers</span>
            <span>{money(table.rows.reduce((sum, row) => sum + row.deal.fee, 0))} expected fees</span>
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
  const onlyLead = new URLSearchParams(route.split("?")[1]).get("lead") || "";
  const onlyPerson = new URLSearchParams(route.split("?")[1]).get("assignee") || "";
  const [editing, setEditing] = useState(null);
  const leads = visibleLeads(state);
  const tasks = visibleTasks(state).filter(
    task =>
      (!mine || task.assignee === ROLES[state.role].person) &&
      (!onlyLead || task.leadId === onlyLead) &&
      (!onlyPerson || task.assignee === onlyPerson) &&
      (filter === "All" || task.done === (filter === "Completed")) &&
      task.title.toLowerCase().includes(search.toLowerCase()),
  );
  const editable = capability(state, "edit") || capability(state, "review");
  if (create && editable)
    return (
      <>
        <Breadcrumb items={[{ label: "Tasks", path: "work/tasks" }, { label: "New task" }]} />
        <PageHeader title="New task" />
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
              <DatePicker name="date" aria-label="Due date" defaultValue={TODAY} required />
            </Field>
            <Field label="Time">
              <TimePicker name="time" aria-label="Time" defaultValue="10:30" />
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
      <PageHeader title="Tasks" description={"All times shown in " + state.settings.timezone + "."}>
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
        {onlyPerson && (
          <button type="button" className="filter-chip" onClick={() => navigate("work/tasks")} aria-label="Show tasks for everyone">
            {onlyPerson} <X size={13} />
          </button>
        )}
        {onlyLead && (
          <button type="button" className="filter-chip" onClick={() => navigate("work/tasks")} aria-label="Show tasks for every lead">
            {leads.find(item => item.id === onlyLead)?.address || "One lead"} <X size={13} />
          </button>
        )}
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
                <Person name={task.assignee} link />
                {editable && <RoundButton label={"Edit " + task.title} icon={PencilSimple} onClick={() => setEditing(task)} />}
              </div>
            );
          })}
        </div>
        {!tasks.length && <Empty title="Nothing waiting here">Try another status or add a next step.</Empty>}
      </Card>
      {editing && (
        <Modal title="Change this next step." onClose={() => setEditing(null)}>
          <form
            onSubmit={event => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              dispatch({
                type: "UPDATE_TASK",
                id: editing.id,
                change: {
                  title: String(data.get("title")),
                  assignee: String(data.get("assignee")),
                  type: String(data.get("type")),
                  date: String(data.get("date")),
                  time: String(data.get("time")),
                  priority: String(data.get("priority")),
                },
              });
              setEditing(null);
              notify("Task updated");
            }}
          >
            <Field label="Task">
              <input name="title" defaultValue={editing.title} required />
            </Field>
            <div className="form-grid">
              <Field label="Responsible person">
                <Select name="assignee" defaultValue={editing.assignee}>
                  {[...new Set([editing.assignee, ROLES[state.role].person, ...PEOPLE])].map(name => (
                    <option key={name}>{name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Task type">
                <Select name="type" defaultValue={editing.type}>
                  {[...new Set([editing.type, "Callback", "Appointment", "Offer", "Data review", "Document"])].filter(Boolean).map(type => (
                    <option key={type}>{type}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Due date">
                <DatePicker name="date" aria-label="Due date" defaultValue={editing.date} required />
              </Field>
              <Field label="Due time">
                <TimePicker name="time" aria-label="Due time" defaultValue={editing.time} required />
              </Field>
              <Field label="Priority">
                <Select name="priority" defaultValue={editing.priority}>
                  {[...new Set([editing.priority, "High", "Normal", "Low"])].filter(Boolean).map(level => (
                    <option key={level}>{level}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="row confirm-actions">
              <Button
                variant="danger-button"
                onClick={() => {
                  const removed = editing;
                  dispatch({ type: "DELETE_TASK", id: removed.id });
                  setEditing(null);
                  notify("Task deleted", { undo: () => dispatch({ type: "RESTORE_TASK", task: removed }) });
                }}
              >
                Delete task
              </Button>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <button className="button primary" type="submit">
                Save changes
              </button>
            </div>
          </form>
        </Modal>
      )}
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
  const slide = useRef(null);
  const direction = useRef(0);
  const travelling = useRef(false);
  const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Going to another month: the current one slides away in the direction of travel, the new one slides in from the other side.
  async function goTo(toYear, toMonth, day) {
    const way = Math.sign(toYear * 12 + toMonth - (year * 12 + month));
    if (day) setSelected(day);
    if (!way || travelling.current) return;
    direction.current = way;
    if (still() || !slide.current) {
      setMonth(toMonth);
      setYear(toYear);
      return;
    }
    travelling.current = true;
    const leaving = slide.current.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: `translateX(${-way * 56}px)`, opacity: 0 },
      ],
      { duration: 150, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    );
    // The timer is a fallback for when the page is hidden and the animation never reports back.
    await Promise.race([leaving.finished.catch(() => {}), new Promise(resolve => setTimeout(resolve, 220))]);
    setMonth(toMonth);
    setYear(toYear);
  }
  function move(delta) {
    const date = new Date(Date.UTC(year, month + delta, 1));
    goTo(date.getUTCFullYear(), date.getUTCMonth());
  }
  useLayoutEffect(() => {
    const element = slide.current;
    if (!element || !direction.current) return;
    element.getAnimations().forEach(animation => animation.cancel());
    if (!still())
      element.animate(
        [
          { transform: `translateX(${direction.current * 56}px)`, opacity: 0 },
          { transform: "none", opacity: 1 },
        ],
        { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    direction.current = 0;
    travelling.current = false;
  }, [month, year]);
  return (
    <>
      <PageHeader title="Calendar" description={"Appointments and next steps · " + state.settings.timezone}>
        <Button onClick={() => goTo(2026, 9, TODAY)}>Today</Button>
        {capability(state, "edit") && (
          <Button variant="primary" icon={Plus} onClick={() => navigate("work/tasks/new")}>
            New task
          </Button>
        )}
      </PageHeader>
      <div className="calendar-layout">
        <Card className="calendar-card">
          <header>
            <h2 key={year + "-" + month} className="view-in">
              {first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}
            </h2>
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
          <div className="calendar-slide" ref={slide}>
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
          </div>
        </Card>
        <Card className="agenda-card" title={selected === TODAY ? "Today, October 15" : selected} subtitle="The next steps on this day.">
          <div className="agenda-list">
            {tasks
              .filter(task => task.date === selected)
              .map(task => (
                <div className="calendar-agenda" key={task.id}>
                  <span>{task.time}</span>
                  <button type="button" className="text-link agenda-title" onClick={() => navigate("work/leads/" + task.leadId)} title="Open the lead">
                    <strong>{task.title}</strong>
                  </button>
                  <Person name={task.assignee} link />
                  <Button disabled={!capability(state, "edit") && !capability(state, "review")} onClick={() => dispatch({ type: "TASK", id: task.id })}>
                    {task.done ? "Reopen" : "Complete"}
                  </Button>
                </div>
              ))}
            {!tasks.some(task => task.date === selected) && <Empty title="A little breathing room">No scheduled next steps on this day.</Empty>}
          </div>
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
      <PageHeader title="Inbox" description="Email, SMS and team messages, each beside its lead.">
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

/** "2026-11-03" as "3 Nov ’26". */
function shortDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const name = new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "short" });
  return day + " " + name + " ’" + String(year).slice(-2);
}
