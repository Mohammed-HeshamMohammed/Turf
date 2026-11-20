// The Evidence tab's phone history: every phone the lead has, with what calling it has shown so far (taken from the lead's calls).
import { CALL_OUTCOMES } from "./data.ts";

type Call = { phone?: string; outcome?: string; code?: string; meaning?: string; at?: string; agent?: string };
type Lead = { phone?: string; phoneType?: string; otherPhones?: { number: string; type?: string }[]; calls?: Call[] };

export type PhoneRecord = {
  number: string;
  type: string;
  primary: boolean;
  calls: number;
  status: string;
  tone: "good" | "danger" | "peach" | "";
  last: { outcome: string; at: string; agent: string } | null;
  counts: Record<string, number>;
};

/** Phones compare by their digits, without a leading US 1. */
export const phoneKey = (raw = "") => {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
};

const meaningOf = (call: Call) => call.meaning || CALL_OUTCOMES.find(item => item.label === call.outcome || item.code === call.code)?.meaning || "";

const STATUS: Record<string, [string, PhoneRecord["tone"]]> = {
  do_not_call: ["Do not call", "danger"],
  disconnected: ["Disconnected", "danger"],
  wrong_number: ["Wrong number", "danger"],
  wrong_person: ["Wrong person", "peach"],
  reached: ["Reached", "good"],
  voicemail: ["Voicemail only", ""],
  no_answer: ["No answer yet", ""],
};

export function phoneHistory(lead: Lead): PhoneRecord[] {
  const phones = [
    ...(lead.phone ? [{ number: lead.phone, type: lead.phoneType || "", primary: true }] : []),
    ...(lead.otherPhones || []).map(item => ({ number: item.number, type: item.type || "", primary: false })),
  ];
  // A phone that was called but is no longer on the lead still shows: what was learned about it stays true.
  for (const call of lead.calls || []) {
    if (call.phone && !phones.some(item => phoneKey(item.number) === phoneKey(call.phone))) phones.push({ number: call.phone, type: "", primary: false });
  }
  return phones.map(phone => {
    const calls = (lead.calls || []).filter(call => call.phone && phoneKey(call.phone) === phoneKey(phone.number)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const counts: Record<string, number> = {};
    for (const call of calls) {
      const meaning = meaningOf(call);
      if (meaning) counts[meaning] = (counts[meaning] || 0) + 1;
    }
    const last = calls.at(-1);
    // Do not call holds once it was said; otherwise the latest call says where the number stands.
    const [status, tone]: [string, PhoneRecord["tone"]] = counts.do_not_call ? STATUS.do_not_call : last ? STATUS[meaningOf(last)] || ["Called", ""] : ["Not called yet", ""];
    return { ...phone, calls: calls.length, status, tone, last: last ? { outcome: last.outcome || "", at: last.at || "", agent: last.agent || "" } : null, counts };
  });
}
