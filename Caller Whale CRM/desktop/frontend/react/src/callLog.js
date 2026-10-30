import { ROLES } from "./data.js";
import { visibleLeads } from "./model.js";

export function visibleCallLog(state) {
  const leads = visibleLeads(state);
  const byId = new Map(leads.map(lead => [lead.id, lead]));
  const entries = new Map((state.callLog || [])
    .filter(call => call.leadId ? byId.has(call.leadId) : call.agent === ROLES[state.role].person)
    .map(call => [call.id, { ...call, name: byId.get(call.leadId)?.name || call.name, outcome: call.leadId ? "Outcome not recorded" : "Completed" }]));
  for (const lead of leads) {
    for (const call of lead.calls || []) {
      entries.set(call.id, { ...entries.get(call.id), ...call, leadId: lead.id, name: lead.name, phone: call.phone || entries.get(call.id)?.phone || lead.phone });
    }
  }
  return [...entries.values()].sort((a, b) => (b.startedAt || new Date(b.at).getTime()) - (a.startedAt || new Date(a.at).getTime()));
}

export function callDuration(call) {
  if (!Number.isFinite(call.startedAt) || !Number.isFinite(call.endedAt)) return "";
  const seconds = Math.max(0, Math.floor((call.endedAt - call.startedAt) / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}
