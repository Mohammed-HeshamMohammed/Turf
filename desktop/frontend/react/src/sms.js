import { capability, visibleLeads, visibleThreads } from "./model.js";
import { phoneNumberKey, validPhoneNumber } from "./phone.js";

/** A phone-number conversation can belong to a known lead or just to the person messaging it. */
export function smsRecipient(state, number) {
  if (!capability(state, "message")) return { error: "SMS is outside this role." };
  if (!validPhoneNumber(number)) return { error: "Enter a phone number with 7–15 digits." };
  const key = phoneNumberKey(number);
  const matches = state.leads.filter(lead => phoneNumberKey(lead.phone) === key);
  const lead = visibleLeads(state).find(lead => matches.some(match => match.id === lead.id));
  if (matches.length && !lead) return { error: "This number is outside your messaging scope." };
  const thread = visibleThreads(state).find(thread => thread.channel === "SMS" && (lead ? thread.leadId === lead.id : !thread.leadId && phoneNumberKey(thread.phone) === key));
  return { lead, thread, phone: lead?.phone || number.trim() };
}
