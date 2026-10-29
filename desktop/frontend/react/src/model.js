import { CALL_OUTCOMES, PEOPLE, ROLES, TODAY, seedState } from "./data.js";
import { detectSourceFields, headerKey, leadFromSource, SOURCE_FIELDS } from "./skiptrace-fields.js";
import { phoneNumberKey, validPhoneNumber } from "./phone.js";

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
// The person's leads are worked out once per state, with a lookup by id: pages ask for them for every row and card,
// which with a list of tens of thousands of leads would otherwise mean hundreds of millions of comparisons.
// A state is never changed in place (the reducer returns a new one), so it is a safe cache key.
const scopes = new WeakMap();
function scope(state) {
  let found = scopes.get(state);
  if (!found) {
    const leads = computeScopedLeads(state);
    found = { leads, visible: leads.filter(lead => !lead.archived), byId: new Map(leads.map(lead => [lead.id, lead])) };
    scopes.set(state, found);
  }
  return found;
}

export function scopedLeads(state) {
  return scope(state).leads;
}

function computeScopedLeads(state) {
  // Server records arrive already scoped to the person.
  if (state.remote) return state.leads;
  const role = ROLES[state.role];
  if (state.role === "admin") return [];
  if (state.role === "client") return state.leads.filter(lead => lead.shared);
  if (["owner", "solo"].includes(state.role)) return state.leads;
  if (["manager", "researcher"].includes(state.role)) return state.leads.filter(lead => lead.team === role.team);
  const incoming = new Set(state.handoffs.filter(item => item.to === role.person && item.status === "Requested").map(item => item.leadId));
  return state.leads.filter(lead => lead.assignee === role.person || incoming.has(lead.id));
}
/** The leads in play: everything in scope except what has been archived. */
export function visibleLeads(state) {
  return scope(state).visible;
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
    inbox: role.pages.includes("inbox") ? visibleThreads(state).filter(thread => thread.unread && thread.channel !== "Email").length : 0,
    mail: role.pages.includes("mail") ? visibleThreads(state).filter(thread => thread.unread && thread.channel === "Email").length : 0,
  };
  return Object.fromEntries(Object.entries(counts).filter(([page]) => role.pages.includes(page)));
}
/** Where a conversation opens: email in Mail, every other channel in Inbox. */
export const conversationPath = thread => (thread.channel === "Email" ? "work/mail?thread=" : "work/inbox?thread=") + thread.id;
/** The quick reactions a message can carry. */
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "🙏"];
const text = (value, max) => String(value ?? "").trim().slice(0, max);
/**
 * What a message carries besides its text, checked before it is stored: a GIF from GIPHY's image hosts, a small
 * photo kept as a data URL (larger ones keep only their name), a file name, the thread lead's address, a contact
 * card, or a poll (team and group chats only). Anything else is refused (null).
 */
export function attachmentFor(thread, attach) {
  if (!attach || !thread) return null;
  switch (attach.kind) {
    case "gif": {
      const url = String(attach.gif?.url || "");
      if (!/^https:\/\/media\d*\.giphy\.com\//.test(url)) return null;
      return { kind: "gif", gif: { url, title: text(attach.gif.title, 120) || "GIF", width: Number(attach.gif.width) || 0, height: Number(attach.gif.height) || 0 } };
    }
    case "photo":
    case "file": {
      const name = text(attach.file?.name, 160);
      if (!name) return null;
      const src = attach.kind === "photo" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(attach.file.src || "") && attach.file.src.length < 700000 ? attach.file.src : undefined;
      return { kind: attach.kind, file: { name, size: Number(attach.file.size) || 0, ...(src ? { src } : {}) } };
    }
    case "location": {
      const address = text(attach.location?.address, 200);
      return address ? { kind: "location", location: { address } } : null;
    }
    case "contact": {
      const name = text(attach.contact?.name, 120);
      return name ? { kind: "contact", contact: { leadId: attach.contact.leadId || null, name, phone: text(attach.contact.phone, 40) } } : null;
    }
    case "poll": {
      if (!["Team", "Group"].includes(thread.channel)) return null;
      const question = text(attach.poll?.question, 200);
      const options = [...new Set((attach.poll?.options || []).map(option => text(option, 80)).filter(Boolean))].slice(0, 10);
      return question && options.length >= 2 ? { kind: "poll", poll: { question, options: options.map(option => ({ text: option, votes: [] })) } } : null;
    }
    default:
      return null;
  }
}
const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const addresses = value => String(value || "").split(/[,;]/).map(item => item.trim()).filter(Boolean);
/** To, Cc and Subject of an email reply or forward: every address must look like one, To needs at least one. */
export function emailFields(fields) {
  if (!fields) return null;
  const to = addresses(fields.to);
  const cc = addresses(fields.cc);
  if (!to.length || ![...to, ...cc].every(item => ADDRESS.test(item)) || to.length + cc.length > 20) return null;
  return { to, cc, subject: text(fields.subject, 200) };
}
const atTop = (id, threads) => [...threads.filter(item => item.id === id), ...threads.filter(item => item.id !== id)];
/** The one line a conversation shows in the list for its latest message. */
export function messagePreview(message) {
  const label = { gif: "GIF", photo: "Photo", file: "File: " + message.file?.name, location: "Location", contact: "Contact: " + message.contact?.name, poll: "Poll: " + message.poll?.question }[message.kind];
  return message.text || label || "";
}
export function visibleThreads(state) {
  if (state.remote) return state.threads;
  const leadIds = new Set(visibleLeads(state).map(lead => lead.id));
  const me = ROLES[state.role].person;
  return state.threads.filter(thread => thread.channel === "Group"
    ? state.role !== "client" && Array.isArray(thread.members) && thread.members.includes(me)
    : thread.leadId
      ? leadIds.has(thread.leadId) && (state.role !== "client" || thread.shared === true)
      : thread.channel === "SMS" && capability(state, "message") && thread.owner === me);
}
export function canEditLead(state, id) {
  if (state.remote) return capability(state, "edit") && scope(state).byId.has(id);
  if (!capability(state, "edit")) return false;
  const lead = scope(state).byId.get(id);
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
/** "Today" or "Oct 16": a day the way every page shows it, never "2026-10-16". */
export function dayLabel(date) {
  if (!date || date === TODAY) return "Today";
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
    case "HYDRATE":
      return restoreState(action.state) ?? state;
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
      const timing = action.session?.lead?.id === lead.id && action.session.callId
        ? { id: action.session.callId, startedAt: action.session.startedAt, endedAt: action.session.endedAt || now.getTime(), endedBy: action.session.endedBy || "agent" }
        : { id: uid() };
      const entry = { ...timing, phone: action.session?.lead?.id === lead.id ? action.session.lead.phone : lead.phone, at, outcome: outcome.label, code: outcome.code, agent: ROLES[state.role].person, scheduled };
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
      if (!deal || !capability(state, "finance") || !canEditLead(state, deal.leadId)) return state;
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
      if (!target || !canEditLead(state, target.id) || Boolean(target.archived) === archiving) return state;
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
      if (!target || !canEditLead(state, target.id)) return state;
      // It always takes two steps: archive, then delete for good. Against a server the removal also needs the assign capability.
      if (!target.archived || (state.remote && !capability(state, "assign"))) return state;
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
      if (!task || (!capability(state, "edit") && !capability(state, "review")) || !visibleTasks(state).some(item => item.id === task.id)) return state;
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
      if (!task || (!capability(state, "edit") && !capability(state, "review")) || !visibleTasks(state).some(item => item.id === task.id)) return state;
      return { ...state, tasks: state.tasks.filter(item => item.id !== task.id), queue: queued(state, task.leadId, "Task removed", "Task") };
    }
    case "RESTORE_TASK": {
      const task = action.task;
      if (!task || state.tasks.some(item => item.id === task.id) || !visibleLeads(state).some(lead => lead.id === task.leadId)) return state;
      return { ...state, tasks: [...state.tasks, task], queue: queued(state, task.leadId, task.title, "Task") };
    }
    case "RESTORE_NOTE": {
      const target = state.leads.find(item => item.id === action.leadId);
      if (!target || !action.note || target.notes.some(item => item.id === action.note.id)) return state;
      const notes = [...target.notes];
      notes.splice(Math.min(action.index ?? notes.length, notes.length), 0, action.note);
      return { ...state, leads: state.leads.map(item => (item.id === target.id ? { ...item, notes } : item)) };
    }
    case "EDIT_NOTE":
    case "DELETE_NOTE": {
      const target = state.leads.find(item => item.id === action.leadId);
      const note = target?.notes.find(item => item.id === action.noteId);
      const author = note?.actor === ROLES[state.role].person;
      if (!note || !(author || canEditLead(state, target.id))) return state;
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
      // A server keeps one deal per lead, so a second one would only be refused there.
      if (!capability(state, "finance") || !target || !canEditLead(state, target.id)) return state;
      if (state.remote && state.deals.some(item => item.leadId === target.id)) return state;
      return {
        ...state,
        deals: [...state.deals, action.deal],
        activities: [event(state, target.id, "Opened a deal for " + target.address, "Deal"), ...state.activities],
        queue: queued(state, target.id, "New deal for " + target.address, "Deal update"),
      };
    }
    case "CALL_LOG": {
      const call = action.call;
      if (!call?.id || !Number.isFinite(call.startedAt) || !Number.isFinite(call.endedAt) || !capability(state, "call")) return state;
      if (call.leadId && !visibleLeads(state).some(lead => lead.id === call.leadId)) return state;
      const existing = (state.callLog || []).find(item => item.id === call.id);
      return { ...state, callLog: [{ ...call, agent: existing?.agent || ROLES[state.role].person }, ...(state.callLog || []).filter(item => item.id !== call.id)] };
    }
    case "MESSAGE": {
      const thread = state.threads.find(item => item.id === action.id);
      const attach = attachmentFor(thread, action.attach);
      if (
        !thread ||
        !visibleThreads(state).some(item => item.id === thread.id) ||
        (!capability(state, "message") && !capability(state, "publicComment")) ||
        (!String(action.text || "").trim() && !attach) ||
        (action.attach && !attach)
      )
        return state;
      if (state.role === "client" && !thread.shared) return state;
      const replyTo = Number.isInteger(action.replyTo) && thread.messages[action.replyTo] ? action.replyTo : undefined;
      const email = thread.channel === "Email" ? emailFields(action.email) : null;
      if (thread.channel === "Email" && action.email && !email) return state;
      const message = {
        from: ROLES[state.role].person,
        text: String(action.text || "").trim(),
        at: state.online ? "Just now · Demo" : "Offline draft",
        incoming: false,
        draft: !state.online,
        ...(attach || {}),
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(email ? { email } : {}),
      };
      return {
        ...state,
        // The conversation with the newest message moves to the top of its list, like any messenger or mail app.
        threads: atTop(thread.id, state.threads.map(item =>
          item.id === thread.id
            ? {
                ...item,
                unread: false,
                preview: messagePreview(message),
                messages: [...item.messages, message],
                // Sending an email ends its draft.
                ...(email ? { emailDraft: undefined } : {}),
                // An email thread keeps one subject; the first reply supplies it when the thread had none.
                ...(email?.subject && !item.subject ? { subject: email.subject.replace(/^(re|fwd?):\s*/i, "") } : {}),
              }
            : item,
        )),
        queue: queued(state, thread.leadId, "Draft message for " + (state.leads.find(item => item.id === thread.leadId)?.name || thread.phone), "Communication draft"),
      };
    }
    case "NEW_THREAD": {
      if (action.thread.channel === "Group") {
        // A group is a chat between teammates: a name, at least two members, and always the person who starts it.
        const me = ROLES[state.role].person;
        const members = [...new Set([me, ...(action.thread.members || [])])].filter(name => PEOPLE.includes(name));
        const title = String(action.thread.title || "").trim().slice(0, 60);
        if (state.role === "client" || state.remote || !capability(state, "message") || !title || members.length < 2) return state;
        return { ...state, threads: [{ ...action.thread, leadId: null, title, members, owner: me, shared: false }, ...state.threads] };
      }
      if (!action.thread.leadId) {
        const thread = action.thread;
        if (state.remote || thread.channel !== "SMS" || !capability(state, "message") || !validPhoneNumber(thread.phone)) return state;
        const key = phoneNumberKey(thread.phone);
        // Known numbers must use the lead path so entering a number cannot evade scope.
        if (state.leads.some(lead => phoneNumberKey(lead.phone) === key) || visibleThreads(state).some(item => !item.leadId && phoneNumberKey(item.phone) === key)) return state;
        return { ...state, threads: [{ ...thread, phone: thread.phone.trim(), owner: ROLES[state.role].person, shared: false }, ...state.threads] };
      }
      if (
        (!capability(state, "message") && !capability(state, "publicComment")) ||
        !visibleLeads(state).some(item => item.id === action.thread.leadId) ||
        (state.role === "client" && (!action.thread.shared || action.thread.channel !== "Partner"))
      )
        return state;
      return { ...state, threads: [action.thread, ...state.threads] };
    }
    case "REACT": {
      // One reaction per emoji per person: a second tap takes it back.
      const thread = visibleThreads(state).find(item => item.id === action.id);
      const message = thread?.messages[action.index];
      if (!message || !REACTIONS.includes(action.emoji)) return state;
      const me = ROLES[state.role].person;
      const people = message.reactions?.[action.emoji] || [];
      const next = people.includes(me) ? people.filter(name => name !== me) : [...people, me];
      const reactions = { ...(message.reactions || {}), [action.emoji]: next };
      if (!next.length) delete reactions[action.emoji];
      return { ...state, threads: state.threads.map(item => (item.id === thread.id ? { ...item, messages: item.messages.map((m, i) => (i === action.index ? { ...m, reactions } : m)) } : item)) };
    }
    case "VOTE": {
      // One vote per person per poll; voting again moves it.
      const thread = visibleThreads(state).find(item => item.id === action.id);
      const message = thread?.messages[action.index];
      if (message?.kind !== "poll" || !message.poll.options[action.option]) return state;
      const me = ROLES[state.role].person;
      const options = message.poll.options.map((option, i) => ({ ...option, votes: option.votes.filter(name => name !== me).concat(i === action.option ? [me] : []) }));
      return { ...state, threads: state.threads.map(item => (item.id === thread.id ? { ...item, messages: item.messages.map((m, i) => (i === action.index ? { ...m, poll: { ...m.poll, options } } : m)) } : item)) };
    }
    case "EMAIL_DRAFT": {
      // The reply or forward being written, kept on its thread until it is sent or discarded (null).
      const thread = visibleThreads(state).find(item => item.id === action.id && item.channel === "Email");
      if (!thread || !capability(state, "message")) return state;
      const draft = action.draft;
      const emailDraft = draft
        ? { mode: draft.mode === "forward" ? "forward" : "reply", to: text(draft.to, 500), cc: text(draft.cc, 500), subject: text(draft.subject, 200), text: String(draft.text || "").slice(0, 20000) }
        : undefined;
      return { ...state, threads: state.threads.map(item => (item.id === thread.id ? { ...item, emailDraft } : item)) };
    }
    case "ARCHIVE": {
      // Archived conversations leave the list for the Archived section, like a messenger; nothing is deleted.
      if (!visibleThreads(state).some(item => item.id === action.id)) return state;
      return { ...state, threads: state.threads.map(item => (item.id === action.id ? { ...item, archived: Boolean(action.archived) } : item)) };
    }
    case "MARK_READ":
      // unread: true marks it unread again, as messengers allow, so it waits in Unread.
      return { ...state, threads: state.threads.map(item => (item.id === action.id ? { ...item, unread: action.unread === true } : item)) };
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
      // What Turf would have chosen by itself; only the differences are lessons. A header mapped elsewhere by hand
      // stops being a lesson for its old field; a field set to "Not mapped" unlearns its old header.
      const detected = detectSourceFields(
        source.columns,
        visibleLeads(state).filter(item => item.datasetId === source.id),
      );
      const learnedHeaders = { ...state.settings.learnedHeaders };
      for (const field of SOURCE_FIELDS) {
        if (!Object.hasOwn(mappings, field.id) || mappings[field.id] === detected[field.id]) continue;
        if (mappings[field.id]) learnedHeaders[headerKey(mappings[field.id])] = field.id;
        else if (detected[field.id] && learnedHeaders[headerKey(detected[field.id])] === field.id) delete learnedHeaders[headerKey(detected[field.id])];
      }
      return {
        ...state,
        settings: { ...state.settings, learnedHeaders },
        datasets: state.datasets.map(item => (item.id === source.id ? { ...item, fieldMappings: mappings } : item)),
        leads: state.leads.map(item => {
          if (item.datasetId !== source.id || !item.sourceValues) return item;
          const data = leadFromSource(source.columns, item, mappings);
          return {
            ...item,
            ...data,
            name: data.name || item.name,
            address: data.address || "Address not supplied",
            version: item.version + 1,
          };
        }),
      };
    }
    case "LOCATE": {
      const places = action.places && typeof action.places === "object" ? action.places : {};
      const missed = new Set(action.notFound || []);
      if (!Object.keys(places).length && !missed.size) return state;
      return {
        ...state,
        leads: state.leads.map(item => {
          const place = places[item.id];
          if (place && Number.isFinite(place.lat) && Number.isFinite(place.lng) && !(item.geo?.precision === "address" && place.precision !== "address"))
            return { ...item, geo: { lat: place.lat, lng: place.lng, precision: place.precision === "address" ? "address" : "zip" } };
          if (missed.has(item.id) && item.geo?.precision !== "address") return { ...item, geo: { ...item.geo, notFound: true } };
          return item;
        }),
      };
    }
    case "CHECK": {
      if (!capability(state, "review") && !capability(state, "import")) return state;
      const original = state.datasets.find(item => item.id === action.id);
      if (!original) return state;
      // A real check (Turf engine) gives each visible lead of the list its verdict. Leads outside the person's view, or
      // of another list, are never touched; a do-not-call verdict already on a lead is kept whatever the check says.
      const visible = new Set(visibleLeads(state).map(item => item.id));
      const verdicts = action.verdicts && typeof action.verdicts === "object" ? action.verdicts : null;
      return {
        ...state,
        datasets: state.datasets.map(item => (item.id === action.id ? { ...item, status: "Checked" } : item)),
        leads: verdicts
          ? state.leads.map(item =>
              item.datasetId === action.id && visible.has(item.id) && typeof verdicts[item.id] === "string" && item.verdict !== "Do not call"
                ? { ...item, verdict: verdicts[item.id], version: item.version + 1 }
                : item,
            )
          : state.leads,
        activities: [event(state, null, (verdicts ? "Checked " : "Saved a demo check of ") + original.name, "Research"), ...state.activities],
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

/** A saved workspace brought up to the current schema, or null when it is not one. */
export function restoreState(saved) {
  if (!([1, 2].includes(saved?.schema) && ROLES[saved.role] && Array.isArray(saved.leads) && Array.isArray(saved.queue) && saved.settings && saved.permissions))
    return null;
  // Schema 1 had no call history or callback dates: its callbacks were times today.
  return saved.schema === 2
    ? saved
    : { ...saved, schema: 2, leads: saved.leads.map(lead => ({ calls: [], callbackDate: lead.callback ? TODAY : "", ...lead })) };
}

/** The workspace an earlier version left in localStorage; the IndexedDB copy (workspace-store.js) replaces it. */
export function loadState(storage) {
  try {
    return restoreState(JSON.parse(storage.getItem("turf.full-crm.prototype.v1"))) ?? seedState();
  } catch {
    /* An unavailable cache starts a fresh sample workspace. */
  }
  return seedState();
}
