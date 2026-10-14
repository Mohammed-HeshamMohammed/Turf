import { ROLES, seedState } from "./data.js";

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
  return state.permissions[state.role]?.[name] ?? ROLES[state.role].capabilities.includes(name);
}
export function visibleLeads(state) {
  const role = ROLES[state.role];
  if (state.role === "admin") return [];
  if (state.role === "client") return state.leads.filter(lead => lead.shared);
  if (["owner", "solo"].includes(state.role)) return state.leads;
  if (["manager", "researcher"].includes(state.role)) return state.leads.filter(lead => lead.team === role.team);
  const incoming = state.handoffs.filter(item => item.to === role.person && item.status === "Requested").map(item => item.leadId);
  return state.leads.filter(lead => lead.assignee === role.person || incoming.includes(lead.id));
}
export function visibleTasks(state) {
  const leadIds = new Set(visibleLeads(state).map(lead => lead.id));
  return state.tasks.filter(task => leadIds.has(task.leadId) && (state.role !== "client" || task.shared));
}
export function visibleThreads(state) {
  const leadIds = new Set(visibleLeads(state).map(lead => lead.id));
  return state.threads.filter(thread => leadIds.has(thread.leadId) && (state.role !== "client" || thread.shared === true));
}
export function canEditLead(state, id) {
  if (!capability(state, "edit")) return false;
  const lead = visibleLeads(state).find(item => item.id === id);
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
      if (!lead || !canEditLead(state, lead.id) || !capability(state, "call") || lead.verdict === "Do not call") return state;
      const change =
        action.outcome === "Reached"
          ? { stage: lead.stage === "New" ? "Contacted" : lead.stage }
          : action.outcome === "Do not call"
            ? { verdict: "Do not call", stage: "Closed", callback: "" }
            : action.outcome === "Wrong number"
              ? { verdict: "Wrong number" }
              : { callback: "10:30" };
      return {
        ...state,
        leads: state.leads.map(item => (item.id === lead.id ? { ...item, ...change } : item)),
        activities: [event(state, lead.id, action.outcome + " · " + lead.name, "Call"), ...state.activities],
        queue: queued(state, lead.id, action.outcome + " · " + lead.name, "Call outcome"),
      };
    }
    case "DEAL": {
      if (!capability(state, "finance")) return state;
      const deal = state.deals.find(item => item.id === action.id);
      if (!deal || !canEditLead(state, deal.leadId)) return state;
      return {
        ...state,
        deals: state.deals.map(item => (item.id === action.id ? { ...item, ...action.change } : item)),
        queue: queued(state, deal.leadId, "Deal moved to " + action.change.stage, "Deal update"),
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
    if (saved?.schema === 1 && ROLES[saved.role] && Array.isArray(saved.leads) && Array.isArray(saved.queue) && saved.settings && saved.permissions)
      return saved;
  } catch {
    /* An unavailable cache starts a fresh sample workspace. */
  }
  return seedState();
}
