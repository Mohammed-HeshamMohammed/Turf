import { CALL_OUTCOMES, ROLES, TODAY, seedState } from "./data.js";
import { mappedRecord, SOURCE_FIELDS } from "./skiptrace-fields.js";

export const uid = () => crypto.randomUUID();
export function personalProfile(state) {
  const person = ROLES[state.role].person;
  return {
    name: person,
    email: person.toLowerCase().replaceAll(" ", ".") + "@example.com",
    taskReminders: true,
    replyReminders: true,
    ...state.personal?.[person],
  };
}
export function capability(state, name) {
  // Connected to a server: the signed-in person's capabilities, which the server enforces again.
  if (state.remote) return state.remote.capabilities.includes(name);
  return state.permissions[state.role]?.[name] ?? ROLES[state.role].capabilities.includes(name);
}
/** Every lead the person's role can reach, archived ones included. */
export function scopedLeads(state) {
  // Server records arrive already scoped to the person.
  if (state.remote) return state.leads;
  const role = ROLES[state.role];
  if (state.role === "admin") return [];
  if (state.role === "client") return state.leads.filter(lead => lead.shared);
  if (["owner", "solo"].includes(state.role)) return state.leads;
  if (["manager", "researcher"].includes(state.role)) return state.leads.filter(lead => lead.team === role.team);
  const incoming = state.handoffs.filter(item => item.to === role.person && item.status === "Requested").map(item => item.leadId);
  return state.leads.filter(lead => lead.assignee === role.person || incoming.includes(lead.id));
}
/** The leads in play: everything in scope except what has been archived. */
export function visibleLeads(state) {
  return scopedLeads(state).filter(lead => !lead.archived);
}
export const archivedLeads = state => scopedLeads(state).filter(lead => lead.archived);
export function visibleTasks(state) {
  if (state.remote) return state.tasks;
  const leadIds = new Set(visibleLeads(state).map(lead => lead.id));
  return state.tasks.filter(task => leadIds.has(task.leadId) && (state.role !== "client" || task.shared));
}
/** Open counts per page that need the person's attention; the sidebar, top tabs and bell all read from here. */
export function navCounts(state, role) {
  const leadIds = new Set(visibleLeads(state).map(lead => lead.id));
  const counts = {
    tasks: visibleTasks(state).filter(task => !task.done).length,
    handoffs: state.handoffs.filter(handoff => handoff.status === "Requested" && leadIds.has(handoff.leadId)).length,
    inbox: role.pages.includes("inbox") ? visibleThreads(state).filter(thread => thread.unread).length : 0,
  };
  return Object.fromEntries(Object.entries(counts).filter(([page]) => role.pages.includes(page)));
}
export function visibleThreads(state) {
  if (state.remote) return state.threads;
  const leadIds = new Set(visibleLeads(state).map(lead => lead.id));
  return state.threads.filter(thread => leadIds.has(thread.leadId) && (state.role !== "client" || thread.shared === true));
}
export function canEditLead(state, id) {
  if (state.remote) return capability(state, "edit") && state.leads.some(item => item.id === id);
  if (!capability(state, "edit")) return false;
  const lead = scopedLeads(state).find(item => item.id === id);
  return Boolean(lead && (["owner", "solo", "manager"].includes(state.role) || lead.assignee === ROLES[state.role].person));
}
function event(state, leadId, text, kind = "Update") {
  return { id: uid(), leadId, text, actor: ROLES[state.role].person, time: "Just now", kind };
}
function queued(state, leadId, label, kind) {
  if (state.online) return state.queue;
  return [
    ...state.queue,
    { id: uid(), leadId, label, kind, actor: ROLES[state.role].person, role: state.role, status: "Pending", at: new Date().toISOString() },
  ];
}
function addDays(day, days) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
/** When the next call is due after an outcome: the time the person asked for, the dialer's recall, or none. */
export function nextCall(lead, outcome, callbackAt) {
  if (outcome.label === "Callback") return callbackAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(callbackAt) ? callbackAt : "";
  if (!outcome.recallDays) return "";
  return addDays(TODAY, outcome.recallDays) + "T" + (lead.callback || "10:00");
}
/** "Today, 10:30", "Oct 16, 10:30", or "" when nothing is scheduled. */
export function callbackLabel(date, time) {
  if (!time) return "";
  if (!date || date === TODAY) return "Today, " + time;
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) + ", " + time;
}
function callbackTasks(state, lead, at, title) {
  const open = state.tasks.filter(task => !(task.leadId === lead.id && task.type === "Callback" && !task.done));
  if (!at) return open;
  const [date, time] = at.split("T");
  return [...open, { id: uid(), title, leadId: lead.id, assignee: lead.assignee, time, date, priority: "Normal", done: false, type: "Callback" }];
}
export function reducer(state, action) {
  const lead = state.leads.find(item => item.id === action.id || item.id === action.leadId);
  switch (action.type) {
    case "ROLE":
      return ROLES[action.role] ? { ...state, role: action.role } : state;
    case "PERSONAL": {
      const person = ROLES[state.role].person;
      return { ...state, personal: { ...state.personal, [person]: { ...personalProfile(state), ...action.profile } } };
    }
    case "CONNECT":
      return { ...state, online: action.online };
    case "RESET":
      return seedState();
    case "UPDATE_LEAD": {
      if (!canEditLead(state, action.id)) return state;
      if (action.change.assignee && (!capability(state, "assign") || !state.online)) return state;
      const text = action.change.stage
        ? lead.name + " moved to " + action.change.stage
        : action.change.assignee
          ? lead.name + " assigned to " + action.change.assignee
          : "Updated " + lead.name + "'s follow-up";
      return {
        ...state,
        leads: state.leads.map(item => (item.id === action.id ? { ...item, ...action.change, version: item.version + 1 } : item)),
        activities: [event(state, action.id, text), ...state.activities],
        queue: queued(state, action.id, text, "Lead update"),
      };
    }
    case "NOTE": {
      if (!lead || (!canEditLead(state, lead.id) && !capability(state, "publicComment")) || !action.text.trim()) return state;
      const visibility = capability(state, "publicComment") ? "shared" : action.visibility || "internal";
      if (state.role === "client" && !lead.shared) return state;
      const note = { id: uid(), text: action.text.trim(), visibility, actor: ROLES[state.role].person, at: "Just now" };
      return {
        ...state,
        leads: state.leads.map(item => (item.id === lead.id ? { ...item, notes: [...item.notes, note] } : item)),
        activities: [event(state, lead.id, "Added a note to " + lead.name, "Note"), ...state.activities],
        queue: queued(state, lead.id, "Note for " + lead.name, "Note"),
      };
    }
    case "HANDOFF": {
      if (
        !lead ||
        !canEditLead(state, lead.id) ||
        !capability(state, "handoff") ||
        !action.note.trim() ||
        state.handoffs.some(item => item.leadId === lead.id && item.status === "Requested")
      )
        return state;
      return {
        ...state,
        handoffs: [
          { id: uid(), leadId: lead.id, from: ROLES[state.role].person, to: action.to, note: action.note.trim(), status: "Requested", at: "Just now" },
          ...state.handoffs,
        ],
        activities: [event(state, lead.id, "Requested a handoff to " + action.to, "Handoff"), ...state.activities],
        queue: queued(state, lead.id, "Handoff for " + lead.name, "Handoff"),
      };
    }
    case "ACCEPT": {
      const handoff = state.handoffs.find(item => item.id === action.id);
      if (
        !state.online ||
        !capability(state, "accept") ||
        !handoff ||
        handoff.status !== "Requested" ||
        (!["manager", "owner", "solo"].includes(state.role) && handoff.to !== ROLES[state.role].person)
      )
        return state;
      const target = state.leads.find(item => item.id === handoff.leadId);
      return {
        ...state,
        handoffs: state.handoffs.map(item => (item.id === handoff.id ? { ...item, status: action.decline ? "Declined" : "Accepted" } : item)),
        leads: action.decline
          ? state.leads
          : state.leads.map(item => (item.id === target.id ? { ...item, assignee: handoff.to, stage: "Qualified", version: item.version + 1 } : item)),
        deals:
          action.decline || state.deals.some(item => item.leadId === target.id)
            ? state.deals
            : [...state.deals, { id: uid(), leadId: target.id, stage: "Qualified", amount: target.value, fee: 0, closeDate: "2026-11-15" }],
        activities: [event(state, target.id, (action.decline ? "Declined" : "Accepted") + " the handoff for " + target.name, "Handoff"), ...state.activities],
      };
    }
    case "TASK": {
      if (!capability(state, "edit") && !capability(state, "review")) return state;
      if (action.task && visibleLeads(state).some(item => item.id === action.task.leadId))
        return {
          ...state,
          tasks: [...state.tasks, { ...action.task, id: uid(), done: false }],
          queue: queued(state, action.task.leadId, action.task.title, "Task"),
        };
      const task = visibleTasks(state).find(item => item.id === action.id);
      if (!task) return state;
      return {
        ...state,
        tasks: state.tasks.map(item => (item.id === action.id ? { ...item, done: !item.done } : item)),
        queue: queued(state, task.leadId, task.title, "Task"),
      };
    }
    case "CALL": {
      const outcome = CALL_OUTCOMES.find(item => item.label === action.outcome);
      if (!outcome || !lead || !canEditLead(state, lead.id) || !capability(state, "call") || lead.verdict === "Do not call") return state;
      const scheduled = nextCall(lead, outcome, action.callbackAt);
      if (outcome.label === "Callback" && !scheduled) return state;
      const [callbackDate, callback] = scheduled ? scheduled.split("T") : ["", ""];
      const reached = outcome.meaning === "reached";
      const change = {
        callback,
        callbackDate,
        stage:
          outcome.label === "Transfer" ? "Qualified" : outcome.label === "Do not call" ? "Closed" : reached && lead.stage === "New" ? "Contacted" : lead.stage,
        ...(outcome.label === "Wrong number" && { verdict: "Wrong number" }),
        ...(outcome.label === "Do not call" && { verdict: "Do not call" }),
        ...(outcome.label === "Transfer" && { sentTo: "Appointments" }),
      };
      const now = new Date();
      const at = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16); // local wall time, like the dialer log
      const entry = { id: uid(), at, outcome: outcome.label, code: outcome.code, agent: ROLES[state.role].person, scheduled };
      const label = outcome.label + " · " + lead.name;
      let tasks = callbackTasks(state, lead, scheduled, (outcome.label === "Callback" ? "Callback: " : "Try again: ") + lead.name);
      if (outcome.label === "Transfer")
        tasks = [
          ...tasks,
          {
            id: uid(),
            title: "Appointment for " + lead.name + " (transferred)",
            leadId: lead.id,
            assignee: lead.assignee,
            time: "",
            date: TODAY,
            priority: "High",
            done: false,
            type: "Appointment",
          },
        ];
      return {
        ...state,
        leads: state.leads.map(item => (item.id === lead.id ? { ...item, ...change, calls: [...(item.calls || []), entry], version: item.version + 1 } : item)),
        tasks,
        activities: [event(state, lead.id, label, "Call"), ...state.activities],
        queue: queued(state, lead.id, label, "Call outcome"),
      };
    }
    case "DEAL": {
      if (!capability(state, "finance")) return state;
      const deal = state.deals.find(item => item.id === action.id);
      if (!deal || !canEditLead(state, deal.leadId)) return state;
      const owner = state.leads.find(item => item.id === deal.leadId);
      // Only a stage change is a story worth telling; amount and date edits stay quiet.
      const moved = action.change.stage && action.change.stage !== deal.stage;
      return {
        ...state,
        deals: state.deals.map(item => (item.id === action.id ? { ...item, ...action.change } : item)),
        activities: moved
          ? [event(state, deal.leadId, "Deal for " + (owner?.address || "a property") + " moved to " + action.change.stage, "Deal"), ...state.activities]
          : state.activities,
        queue: queued(state, deal.leadId, "Deal moved to " + (action.change.stage || deal.stage), "Deal update"),
      };
    }
    case "DELETE_DEAL": {
      const deal = state.deals.find(item => item.id === action.id);
      if (state.remote || !deal || !capability(state, "finance") || !canEditLead(state, deal.leadId)) return state;
      const owner = state.leads.find(item => item.id === deal.leadId);
      return {
        ...state,
        deals: state.deals.filter(item => item.id !== action.id),
        activities: [event(state, deal.leadId, "Removed the deal for " + (owner?.address || "a property"), "Deal"), ...state.activities],
        queue: queued(state, deal.leadId, "Deal removed", "Deal update"),
      };
    }
    case "ARCHIVE_LEAD":
    case "RESTORE_LEAD": {
      const archiving = action.type === "ARCHIVE_LEAD";
      const target = state.leads.find(item => item.id === action.id);
      if (state.remote || !target || !canEditLead(state, target.id) || Boolean(target.archived) === archiving) return state;
      const text = (archiving ? "Archived " : "Restored ") + target.name;
      return {
        ...state,
        leads: state.leads.map(item => (item.id === target.id ? { ...item, archived: archiving, version: item.version + 1 } : item)),
        activities: [event(state, target.id, text), ...state.activities],
        queue: queued(state, target.id, text, "Lead update"),
      };
    }
    case "DELETE_LEAD": {
      const target = state.leads.find(item => item.id === action.id);
      // Only an archived lead can be deleted, so it always takes two deliberate steps.
      if (state.remote || !target || !target.archived || !canEditLead(state, target.id)) return state;
      return {
        ...state,
        leads: state.leads.filter(item => item.id !== target.id),
        deals: state.deals.filter(item => item.leadId !== target.id),
        tasks: state.tasks.filter(item => item.leadId !== target.id),
        threads: state.threads.filter(item => item.leadId !== target.id),
        handoffs: state.handoffs.filter(item => item.leadId !== target.id),
        activities: state.activities.filter(item => item.leadId !== target.id),
        queue: state.queue.filter(item => item.leadId !== target.id),
      };
    }
    case "UPDATE_TASK": {
      const task = state.tasks.find(item => item.id === action.id);
      if (state.remote || !task || (!capability(state, "edit") && !capability(state, "review")) || !visibleTasks(state).some(item => item.id === task.id))
        return state;
      const change = {};
      for (const key of ["title", "date", "time", "assignee", "priority", "type"])
        if (typeof action.change[key] === "string") change[key] = action.change[key].trim();
      if ("title" in change && !change.title) return state;
      return {
        ...state,
        tasks: state.tasks.map(item => (item.id === task.id ? { ...item, ...change } : item)),
        queue: queued(state, task.leadId, change.title || task.title, "Task"),
      };
    }
    case "DELETE_TASK": {
      const task = state.tasks.find(item => item.id === action.id);
      if (state.remote || !task || (!capability(state, "edit") && !capability(state, "review")) || !visibleTasks(state).some(item => item.id === task.id))
        return state;
      return { ...state, tasks: state.tasks.filter(item => item.id !== task.id), queue: queued(state, task.leadId, "Task removed", "Task") };
    }
    case "EDIT_NOTE":
    case "DELETE_NOTE": {
      const target = state.leads.find(item => item.id === action.leadId);
      const note = target?.notes.find(item => item.id === action.noteId);
      const author = note?.actor === ROLES[state.role].person;
      if (state.remote || !note || !(author || canEditLead(state, target.id))) return state;
      if (action.type === "EDIT_NOTE" && !String(action.text || "").trim()) return state;
      const notes =
        action.type === "EDIT_NOTE"
          ? target.notes.map(item => (item.id === note.id ? { ...item, text: action.text.trim(), edited: true } : item))
          : target.notes.filter(item => item.id !== note.id);
      return {
        ...state,
        leads: state.leads.map(item => (item.id === target.id ? { ...item, notes } : item)),
        queue: queued(state, target.id, "Note on " + target.name, "Note"),
      };
    }
    case "NEW_DEAL": {
      const target = state.leads.find(item => item.id === action.deal.leadId);
      if (state.remote || !capability(state, "finance") || !target || !canEditLead(state, target.id)) return state;
      return {
        ...state,
        deals: [...state.deals, action.deal],
        activities: [event(state, target.id, "Opened a deal for " + target.address, "Deal"), ...state.activities],
        queue: queued(state, target.id, "New deal for " + target.address, "Deal update"),
      };
    }
    case "MESSAGE": {
      const thread = state.threads.find(item => item.id === action.id);
      if (
        !thread ||
        !visibleLeads(state).some(item => item.id === thread.leadId) ||
        (!capability(state, "message") && !capability(state, "publicComment")) ||
        !action.text.trim()
      )
        return state;
      if (state.role === "client" && !thread.shared) return state;
      const message = {
        from: ROLES[state.role].person,
        text: action.text.trim(),
        at: state.online ? "Just now · Demo" : "Offline draft",
        incoming: false,
        draft: !state.online,
      };
      return {
        ...state,
        threads: state.threads.map(item =>
          item.id === thread.id ? { ...item, unread: false, preview: message.text, messages: [...item.messages, message] } : item,
        ),
        queue: queued(state, thread.leadId, "Draft message for " + state.leads.find(item => item.id === thread.leadId).name, "Communication draft"),
      };
    }
    case "NEW_THREAD": {
      if (
        (!capability(state, "message") && !capability(state, "publicComment")) ||
        !visibleLeads(state).some(item => item.id === action.thread.leadId) ||
        (state.role === "client" && (!action.thread.shared || action.thread.channel !== "Partner"))
      )
        return state;
      return { ...state, threads: [...state.threads, action.thread] };
    }
    case "MARK_READ":
      return { ...state, threads: state.threads.map(item => (item.id === action.id ? { ...item, unread: false } : item)) };
    case "CONFLICT": {
      const pending = state.queue.find(item => item.actor === ROLES[state.role].person && item.kind !== "Communication draft");
      return {
        ...state,
        queue: state.queue.map(item => (item.id === pending?.id ? { ...item, status: "Conflict", serverValue: "A teammate updated this record" } : item)),
      };
    }
    case "RESOLVE": {
      const own = item => item.id === action.id && item.actor === ROLES[state.role].person;
      return {
        ...state,
        queue: action.discard ? state.queue.filter(item => !own(item)) : state.queue.map(item => (own(item) ? { ...item, status: "Reviewed" } : item)),
      };
    }
    case "SYNC": {
      if (!state.online) return state;
      return {
        ...state,
        queue: state.queue.filter(item => item.actor !== ROLES[state.role].person || item.status === "Conflict" || item.kind === "Communication draft"),
        activities: [event(state, null, "Synchronized pending CRM changes", "Sync"), ...state.activities],
      };
    }
    case "IMPORT": {
      if (!capability(state, "import")) return state;
      return { ...state, datasets: [...state.datasets, action.dataset], leads: [...state.leads, ...action.leads] };
    }
    case "SOURCE_MAPPING": {
      if (!capability(state, "review") && !capability(state, "import")) return state;
      const source = state.datasets.find(item => item.id === action.id);
      if (!source || !visibleLeads(state).some(item => item.datasetId === source.id)) return state;
      const mappings = Object.fromEntries(
        SOURCE_FIELDS.filter(field => Object.hasOwn(action.mappings, field.id)).map(field => [
          field.id,
          source.columns.includes(action.mappings[field.id]) ? action.mappings[field.id] : "",
        ]),
      );
      return {
        ...state,
        datasets: state.datasets.map(item => (item.id === source.id ? { ...item, fieldMappings: mappings } : item)),
        leads: state.leads.map(item => {
          if (item.datasetId !== source.id || !item.sourceValues) return item;
          const data = mappedRecord(source.columns, item, mappings);
          return {
            ...item,
            ...data,
            name: data.name || item.name,
            address: data.address || "Address not supplied",
            value: source.columns.includes(mappings.value) ? Number(data.value.replace(/[$,]/g, "")) || 0 : item.value,
            version: item.version + 1,
          };
        }),
      };
    }
    case "CHECK": {
      if (!capability(state, "review") && !capability(state, "import")) return state;
      const original = state.datasets.find(item => item.id === action.id);
      if (!original) return state;
      return {
        ...state,
        datasets: state.datasets.map(item => (item.id === action.id ? { ...item, status: "Checked" } : item)),
        activities: [event(state, null, "Saved a demo check of " + original.name, "Research"), ...state.activities],
      };
    }
    case "NEW_LEAD": {
      if (!capability(state, "edit")) return state;
      return { ...state, leads: [...state.leads, action.lead], queue: queued(state, action.lead.id, "New lead: " + action.lead.name, "New lead") };
    }
    case "RULE":
      return capability(state, "rules")
        ? { ...state, rules: state.rules.map(item => (item.id === action.id ? { ...item, enabled: !item.enabled } : item)) }
        : state;
    case "SETTINGS":
      return capability(state, "admin") || capability(state, "rules") ? { ...state, settings: { ...state.settings, ...action.settings } } : state;
    case "INTEGRATION":
      return capability(state, "admin") ? { ...state, integrations: { ...state.integrations, [action.name]: action.connected } } : state;
    case "PERMISSION":
      return capability(state, "admin")
        ? { ...state, permissions: { ...state.permissions, [action.role]: { ...state.permissions[action.role], [action.name]: action.allowed } } }
        : state;
    case "REPORT_SCHEDULE":
      return capability(state, "finance") ? { ...state, reportSchedules: [...state.reportSchedules, action.schedule] } : state;
    default:
      return state;
  }
}

export function loadState(storage) {
  try {
    const saved = JSON.parse(storage.getItem("turf.full-crm.prototype.v1"));
    if ([1, 2].includes(saved?.schema) && ROLES[saved.role] && Array.isArray(saved.leads) && Array.isArray(saved.queue) && saved.settings && saved.permissions)
      // Schema 1 had no call history or callback dates: its callbacks were times today.
      return saved.schema === 2
        ? saved
        : { ...saved, schema: 2, leads: saved.leads.map(lead => ({ calls: [], callbackDate: lead.callback ? TODAY : "", ...lead })) };
  } catch {
    /* An unavailable cache starts a fresh sample workspace. */
  }
  return seedState();
}
