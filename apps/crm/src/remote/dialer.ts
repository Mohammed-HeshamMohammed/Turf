// The dialer service (services/telnyx) from the app: place a call, follow it, hang up, and say how it went.
// The dialer is the record of every call it places: it logs the finished call in crm-core itself (call.record), so the
// app must not log the same call again (calling.ts decides that).

import { request } from "./api.ts";
import { wallTimeInstant } from "../data.ts";

const remembered = key => {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
};

/** Where the dialer is (VITE_CALLERWHALE_DIALER_URL). Empty: this build places no calls and keeps the demo call. */
export function dialerBase(): string {
  return (remembered("callerwhale.dialer.url") || import.meta.env?.VITE_CALLERWHALE_DIALER_URL || "").replace(/\/$/, "");
}

/** The dialer's view of one call (callRow in services/telnyx/calls.go), only the fields the app reads. */
export type DialerCall = {
  id: string;
  lead_id: string | null;
  answered_at: string | null;
  ended_at: string | null;
  hangup_source: string; // "caller" (our side), "callee" (the lead) or "unknown"
  outcome: string;
  report_state: string;
};

type Send = (method: string, path: string, body?: unknown, options?: { base?: string }) => Promise<any>;

// What the person may choose after a call (dispositions in services/telnyx/outcome.go) that the CRM also offers.
const DIALER_OUTCOMES = new Set(["Not interested", "Callback", "Transfer", "Language barrier", "Wrong number", "Do not call", "Dead call"]);

/** The CRM's outcome as the dialer takes it. Voicemail and Not available are what the carrier saw: "auto". */
export function toDialerOutcome(label: string): string {
  return DIALER_OUTCOMES.has(label) ? label : "auto";
}

export function dialerClient(send: Send = request, base: () => string = dialerBase) {
  const call = (method: string, path: string, body?: unknown) => send(method, path, body, { base: base() });
  return {
    /** The server dials the lead's number from the CRM; the browser never sends a number. `scenario` works in simulate mode only. */
    place: (leadId: string, scenario = ""): Promise<DialerCall> => call("POST", "/api/v1/calls", { lead_id: leadId, ...(scenario ? { scenario } : {}) }),
    get: (id: string): Promise<DialerCall> => call("GET", `/api/v1/calls/${encodeURIComponent(id)}`),
    hangup: (id: string): Promise<DialerCall> => call("POST", `/api/v1/calls/${encodeURIComponent(id)}/hangup`, {}),
    wrapUp: (id: string, { outcome, callbackAt = "", notes = "" }: { outcome: string; callbackAt?: string; notes?: string }): Promise<DialerCall> =>
      call("POST", `/api/v1/calls/${encodeURIComponent(id)}/disposition`, {
        outcome: toDialerOutcome(outcome),
        // The picker's time is the workspace's clock, not the caller's computer's.
        callback_at: callbackAt ? wallTimeInstant(callbackAt) : "",
        notes,
        dnc_kind: outcome === "Do not call" ? "agency" : "",
      }),
  };
}

export const dialer = dialerClient();
