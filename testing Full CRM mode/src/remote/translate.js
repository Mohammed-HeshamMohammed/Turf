// Translation between the Turf API's records and this prototype's state, and from prototype actions to API
// operations. Pure functions: the sync engine and the tests use them the same way.

import { ROLES } from "../data.js";

/** The prototype role for a member's server roles; the broadest wins. */
export function roleKey(roles = []) {
  return ["solo", "owner", "manager", "closer", "caller", "researcher", "client", "admin"].find(key => roles.includes(key)) || "caller";
}

const pad = value => String(value).padStart(2, "0");

/** A server time as the prototype's local callback date ("2026-10-16") and time ("15:12"). */
export function localParts(iso) {
  if (!iso) return ["", ""];
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return ["", ""];
  return [date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()), pad(date.getHours()) + ":" + pad(date.getMinutes())];
}

/** A local date and time back to an ISO instant, or null when either is missing. */
export function isoFromLocal(date, time) {
  if (!date || !time) return null;
  const value = new Date(date + "T" + time);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

function nameOf(directory, id) {
  if (!id) return "Unassigned";
  return directory.find(person => person.id === id)?.name || "Former member";
}

export function idOf(directory, name) {
  return directory.find(person => person.name === name)?.id || null;
}

function teamName(teams, id) {
  return teams.find(team => team.id === id)?.name || "";
}

/** One server lead (with its property, calls and notes) as a prototype lead. */
export function leadFromServer(lead, { directory = [], teams = [], calls = [], notes = [] } = {}) {
  const property = lead.property || {};
  const [callbackDate, callback] = localParts(lead.next_action_at);
  return {
    id: lead.id,
    name: lead.name,
    address: property.address || "Address not supplied",
    unit: property.unit || "",
    city: property.city || "",
    region: property.region || "",
    zip: property.postal_code || "",
    country: property.country || "",
    latitude: property.latitude ?? null,
    longitude: property.longitude ?? null,
    stage: lead.stage,
    assignee: nameOf(directory, lead.assignee_id),
    team: teamName(teams, lead.team_id),
    datasetId: lead.project_id || "",
    callback,
    callbackDate,
    value: lead.value_amount == null ? 0 : Number(lead.value_amount),
    shared: Boolean(lead.shared_external),
    verdict: lead.do_not_call ? "Do not call" : lead.verdict || "Unverified",
    phone: lead.phone || "",
    email: lead.email || "",
    source: lead.source || "",
    priority: lead.priority || "Normal",
    sentTo: lead.sent_to || "",
    version: lead.version,
    beds: property.details?.beds ?? null,
    baths: property.details?.baths ?? null,
    area: property.details?.area ?? null,
    motivation: lead.next_action || "",
    calls: calls
      .filter(call => call.lead_id === lead.id)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
      .map(call => ({
        id: call.id,
        at: localParts(call.occurred_at).join("T"),
        outcome: call.outcome,
        code: call.code,
        agent: call.agent_label || nameOf(directory, call.agent_id),
        scheduled: call.scheduled_at ? localParts(call.scheduled_at).join("T") : "",
      })),
    notes: notes
      .filter(note => note.lead_id === lead.id)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
      .map(note => ({ id: note.id, text: note.body, visibility: note.visibility, actor: note.author_label, at: new Date(note.occurred_at).toLocaleString() })),
  };
}

export function taskFromServer(task, directory = []) {
  const [date, time] = localParts(task.due_at);
  return {
    id: task.id,
    title: task.title,
    leadId: task.lead_id,
    assignee: nameOf(directory, task.assignee_id),
    time,
    date,
    priority: task.priority,
    done: Boolean(task.done_at),
    type: task.type,
    shared: Boolean(task.shared_external),
    recurrence: task.recurrence || "",
  };
}

export function dealFromServer(deal) {
  return {
    id: deal.id,
    leadId: deal.lead_id,
    stage: deal.stage,
    amount: deal.amount == null ? 0 : Number(deal.amount),
    fee: deal.fee == null ? 0 : Number(deal.fee),
    closeDate: deal.close_date || "",
  };
}

export function handoffFromServer(handoff, directory = []) {
  return {
    id: handoff.id,
    leadId: handoff.lead_id,
    from: nameOf(directory, handoff.from_user),
    to: nameOf(directory, handoff.to_user),
    note: handoff.note,
    status: handoff.status,
    at: new Date(handoff.created_at).toLocaleString(),
  };
}

/** The record collections of prototype state from the server's raw store. */
export function collectionsFromStore(store) {
  const records = kind => Object.values(store[kind] || {});
  const context = { directory: store.directory || [], teams: store.teams || [], calls: records("calls"), notes: records("notes") };
  return {
    leads: records("leads")
      .map(lead => leadFromServer(lead, context))
      .sort((a, b) => a.name.localeCompare(b.name)),
    tasks: records("tasks").map(task => taskFromServer(task, context.directory)),
    deals: records("deals").map(dealFromServer),
    handoffs: records("handoffs").map(handoff => handoffFromServer(handoff, context.directory)),
    datasets: (store.projects || []).map(project => ({
      id: project.id,
      name: project.name,
      description: "Server project",
      status: "Checked",
      team: "",
      date: "",
      columns: [],
      rows: records("leads").filter(lead => lead.project_id === project.id).length,
    })),
  };
}

/** Applies a /sync/pull page to the raw store. Removals drop records no longer visible. */
export function applyChanges(store, changes) {
  const next = { ...store };
  const plural = { lead: "leads", task: "tasks", note: "notes", call: "calls", deal: "deals", handoff: "handoffs", message: "messages" };
  for (const change of changes) {
    const kind = plural[change.entity];
    if (!kind) continue;
    next[kind] = { ...(next[kind] || {}) };
    if (change.op === "remove") {
      delete next[kind][change.id];
      if (change.entity === "lead") {
        // Everything hanging off a lead goes with it.
        for (const child of ["tasks", "notes", "calls", "deals", "handoffs"]) {
          next[child] = Object.fromEntries(Object.entries(next[child] || {}).filter(([, record]) => record.lead_id !== change.id));
        }
      }
    } else {
      const previous = next[kind][change.id];
      // A pulled lead has no property; keep the one the snapshot gave.
      next[kind][change.id] =
        change.entity === "lead" && previous?.property && !change.record.property ? { ...change.record, property: previous.property } : change.record;
    }
  }
  return next;
}

export function storeFromSnapshot(snapshot, extra = {}) {
  const byId = list => Object.fromEntries((list || []).map(record => [record.id, record]));
  return {
    ...extra,
    cursor: snapshot.cursor,
    accessRevision: snapshot.access_revision,
    leaseExpiresAt: snapshot.offline_lease_expires_at,
    leads: byId(snapshot.leads),
    tasks: byId(snapshot.tasks),
    notes: byId(snapshot.notes),
    calls: byId(snapshot.calls),
    deals: byId(snapshot.deals),
    handoffs: byId(snapshot.handoffs),
  };
}

const uuid = () => crypto.randomUUID();

/**
 * The API operation for a prototype action, given the state the person edited (before the action). Returns null for
 * actions that stay on this device (role preview, layout, read markers) and { online: true, ... } for changes that
 * need a connection and must not wait in the queue.
 */
export function operationFor(action, before, store) {
  const directory = store.directory || [];
  const lead = before.leads.find(item => item.id === action.id || item.id === action.leadId);
  const base = { id: uuid(), claimed_at: new Date().toISOString(), queued_offline: !before.online };
  switch (action.type) {
    case "UPDATE_LEAD": {
      if (!lead) return null;
      const { change } = action;
      if (change.assignee !== undefined) {
        return {
          ...base,
          online: true,
          kind: "lead.assign",
          payload: { ids: [lead.id], assignee_id: idOf(directory, change.assignee), reason: "Changed in the lead record" },
        };
      }
      const changes = {};
      const edited = {};
      if (change.stage !== undefined) {
        changes.stage = change.stage;
        edited.stage = lead.stage;
      }
      if (change.callback !== undefined || change.callbackDate !== undefined) {
        const date = change.callbackDate ?? lead.callbackDate;
        const time = change.callback ?? lead.callback;
        changes.next_action_at = isoFromLocal(date, time);
        edited.next_action_at = isoFromLocal(lead.callbackDate, lead.callback);
      }
      if (!Object.keys(changes).length) return null;
      return { ...base, kind: "lead.update", payload: { id: lead.id, changes, base: edited } };
    }
    case "NOTE":
      if (!lead || !action.text?.trim()) return null;
      return { ...base, kind: "note.add", payload: { lead_id: lead.id, body: action.text.trim(), visibility: action.visibility || "internal" } };
    case "HANDOFF":
      if (!lead) return null;
      return { ...base, kind: "handoff.request", payload: { lead_id: lead.id, to_user: idOf(directory, action.to), note: action.note } };
    case "ACCEPT":
      return { ...base, online: true, kind: "handoff.decide", payload: { id: action.id, decision: action.decline ? "decline" : "accept" } };
    case "TASK": {
      if (action.task) {
        return {
          ...base,
          kind: "task.create",
          payload: {
            id: uuid(),
            lead_id: action.task.leadId || null,
            title: action.task.title,
            type: action.task.type,
            priority: action.task.priority,
            due_at: isoFromLocal(action.task.date, action.task.time || "09:00"),
            assignee_id: idOf(directory, action.task.assignee),
          },
        };
      }
      const task = before.tasks.find(item => item.id === action.id);
      if (!task) return null;
      return { ...base, kind: "task.complete", payload: { id: task.id, done: !task.done } };
    }
    case "CALL":
      if (!lead) return null;
      return {
        ...base,
        kind: "call.record",
        payload: { lead_id: lead.id, outcome: action.outcome, callback_at: action.callbackAt ? new Date(action.callbackAt).toISOString() : null },
      };
    case "DEAL": {
      const deal = before.deals.find(item => item.id === action.id);
      if (!deal) return null;
      const changes = {};
      const edited = {};
      for (const [field, server] of [
        ["stage", "stage"],
        ["amount", "amount"],
        ["fee", "fee"],
        ["closeDate", "close_date"],
      ]) {
        if (action.change[field] !== undefined) {
          changes[server] = action.change[field];
          edited[server] = deal[field];
        }
      }
      return { ...base, kind: "deal.update", payload: { id: deal.id, changes, base: edited } };
    }
    case "DELETE_LEAD":
      return lead ? { ...base, online: true, kind: "lead.delete", payload: { id: lead.id } } : null;
    case "NEW_DEAL": {
      const deal = action.deal;
      const owner = before.leads.find(item => item.id === deal?.leadId);
      if (!owner) return null;
      return {
        ...base,
        kind: "deal.create",
        payload: { id: deal.id, lead_id: owner.id, stage: deal.stage, amount: deal.amount, fee: deal.fee, close_date: deal.closeDate || null },
      };
    }
    case "DELETE_DEAL": {
      const deal = before.deals.find(item => item.id === action.id);
      return deal ? { ...base, online: true, kind: "deal.delete", payload: { id: deal.id } } : null;
    }
    case "UPDATE_TASK": {
      const task = before.tasks.find(item => item.id === action.id);
      if (!task) return null;
      const changes = {};
      const edited = {};
      const { change } = action;
      for (const field of ["title", "type", "priority"]) {
        if (typeof change[field] === "string") {
          changes[field] = change[field].trim();
          edited[field] = task[field];
        }
      }
      if (typeof change.assignee === "string") {
        changes.assignee_id = idOf(directory, change.assignee);
        edited.assignee_id = idOf(directory, task.assignee);
      }
      if (typeof change.date === "string" || typeof change.time === "string") {
        changes.due_at = isoFromLocal(change.date ?? task.date, change.time ?? task.time);
        edited.due_at = isoFromLocal(task.date, task.time);
      }
      return Object.keys(changes).length ? { ...base, kind: "task.update", payload: { id: task.id, changes, base: edited } } : null;
    }
    case "RESTORE_TASK": {
      const task = action.task;
      if (!task) return null;
      return {
        ...base,
        kind: "task.create",
        payload: {
          id: task.id,
          lead_id: task.leadId || null,
          title: task.title,
          type: task.type,
          priority: task.priority,
          due_at: isoFromLocal(task.date, task.time || "09:00"),
          assignee_id: idOf(directory, task.assignee),
        },
      };
    }
    case "DELETE_TASK": {
      const task = before.tasks.find(item => item.id === action.id);
      return task ? { ...base, online: true, kind: "task.delete", payload: { id: task.id } } : null;
    }
    case "MESSAGE": {
      const thread = before.threads.find(item => item.id === action.id);
      if (!thread || !action.text?.trim()) return null;
      return {
        ...base,
        kind: "message.draft",
        payload: { conversation_id: thread.serverId || null, lead_id: thread.leadId, channel: "email", body: action.text.trim() },
      };
    }
    case "NEW_LEAD": {
      const created = action.lead;
      return {
        ...base,
        kind: "lead.create",
        payload: {
          id: created.id,
          name: created.name,
          phone: created.phone,
          email: created.email,
          address: created.address,
          unit: created.unit,
          city: created.city,
          region: created.region,
          zip: created.zip,
          country: created.country,
          latitude: created.latitude ?? null,
          longitude: created.longitude ?? null,
          assignee_id: idOf(directory, created.assignee),
          next_action_at: isoFromLocal(created.callbackDate, created.callback),
        },
      };
    }
    default:
      return null;
  }
}

/** A short label for a queued operation, for the Sync page. */
export function labelFor(op, before) {
  const lead = before.leads.find(item => item.id === (op.payload.lead_id || op.payload.id || op.payload.ids?.[0]));
  const name = lead ? " · " + lead.name : "";
  const labels = {
    "lead.update": "Lead change",
    "lead.assign": "Assignment",
    "note.add": "Note",
    "handoff.request": "Handoff request",
    "handoff.decide": "Handoff decision",
    "task.create": "New task",
    "task.complete": "Task completion",
    "call.record": "Call outcome: " + (op.payload.outcome || ""),
    "deal.update": "Deal change",
    "lead.delete": "Lead removal",
    "deal.create": "New deal",
    "deal.delete": "Deal removal",
    "task.update": "Task change",
    "task.delete": "Task removal",
    "message.draft": "Message draft",
    "lead.create": "New lead",
  };
  return (labels[op.kind] || op.kind) + name;
}

/** Makes the prototype's role table speak for the signed-in person. */
export function applyIdentity(me) {
  const key = roleKey(me.roles);
  const role = ROLES[key];
  role.person = me.user.name;
  role.capabilities = [...me.capabilities];
  return key;
}
