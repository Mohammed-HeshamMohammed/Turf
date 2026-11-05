import { canEditLead, capability, visibleLeads } from "./model.js";
import { phoneNumberKey as dialNumberKey } from "./phone.js";
export { phoneNumberKey as dialNumberKey } from "./phone.js";

/** Resolve a typed number without creating a lead or bypassing an existing contact's calling restrictions. */
export function dialerTarget(state, number) {
  if (!capability(state, "call")) return { error: "Calling is outside this role." };
  const digits = String(number).replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15 || !/^\+?[\d ()*#-]+$/.test(number)) return { error: "Enter a phone number with 7–15 digits." };
  const matches = state.leads.filter(item => dialNumberKey(item.phone) === dialNumberKey(number));
  if (matches.some(item => ["Do not call", "Wrong number"].includes(item.verdict) || item.stage === "Closed")) return { error: "Calling is unavailable for this number." };
  if (matches.length) {
    const lead = visibleLeads(state).find(item => matches.some(match => match.id === item.id) && canEditLead(state, item.id));
    return lead ? { lead } : { error: "This number is outside your calling scope." };
  }
  return { lead: { id: "manual-" + crypto.randomUUID(), name: "Dialed number", phone: number.trim(), address: "", adHoc: true } };
}
