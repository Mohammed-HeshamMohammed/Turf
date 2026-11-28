import { useSyncExternalStore } from "react";

// What a running call shares with the rest of the app: whether captions are on, whether a call is live, who it is with,
// and what has been said so far. It lives outside any page so the call, its caption bar and the assistant carry on
// while you move around the app (and so a pop-out window can mirror it).
const CAPTIONS_KEY = "callerwhale.full-crm.captions";
const SOURCE_KEY = "callerwhale.full-crm.captions-source";

function read(key, fallback) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

let session = {
  captions: read(CAPTIONS_KEY, "off") === "on",
  // "demo" plays a sample conversation; "mic" captions what the microphone hears.
  source: read(SOURCE_KEY, "demo") === "mic" ? "mic" : "demo",
  micState: "idle",
  // True while the captions float in their own desktop window instead of inside the app.
  popout: false,
  active: false,
  callId: null,
  awaitingOutcome: false,
  startedAt: null,
  endedAt: null,
  endedBy: null,
  // How the call was made: "demo" (nothing dialled), "dialer" (the dialer service) or "real" (Option B, the browser).
  mode: "demo",
  // The dialer's id for this call, so the page can follow it, hang it up and save its outcome there.
  serverCallId: null,
  // When the other side answered; null while it rings.
  answeredAt: null,
  // Why the call's status is unknown right now (the dialer stopped answering), or "".
  trouble: "",
  lead: null,
  // Settled lines, oldest first: { id, who, side, text }.
  transcript: [],
};
const listeners = new Set<() => void>();
const logListeners = new Set<(_call: any) => void>();
export function subscribeCallLog(listener) {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}

export const getCallSession = () => session;

export function setCallSession(patch) {
  session = { ...session, ...patch };
  try {
    if ("captions" in patch) window.localStorage.setItem(CAPTIONS_KEY, session.captions ? "on" : "off");
    if ("source" in patch) window.localStorage.setItem(SOURCE_KEY, session.source);
  } catch {
    /* The choice still holds for this session. */
  }
  listeners.forEach(listener => listener());
}

/** Starting another call is blocked until the current call's outcome has been saved. Checked before any call is placed. */
export function canBeginCall(lead) {
  return !session.active && !session.awaitingOutcome && Boolean(lead?.phone?.trim());
}

function startSession(lead, mode, serverCallId) {
  const startedAt = Date.now();
  setCallSession({
    active: true,
    callId: crypto.randomUUID(),
    awaitingOutcome: false,
    lead: { id: lead.id, name: lead.name, phone: lead.phone, address: lead.address, motivation: lead.motivation, adHoc: Boolean(lead.adHoc) },
    startedAt,
    endedAt: null,
    endedBy: null,
    transcript: [],
    mode,
    serverCallId,
    // Nothing rings in a demo call: it is "in progress" at once.
    answeredAt: mode === "demo" ? startedAt : null,
    trouble: "",
  });
}

export function beginDemoCall(lead) {
  if (!canBeginCall(lead)) return false;
  startSession(lead, "demo", null);
  return true;
}

/** A call the dialer placed (or, in Option B, the browser): the same gate as a demo call, ringing until answered. */
export function beginServerCall(lead, serverCallId, mode = "dialer") {
  if (!canBeginCall(lead)) return false;
  startSession(lead, mode, serverCallId);
  return true;
}

/** The other side answered. Only the first answer counts. */
export function markAnswered(at = Date.now()) {
  if (session.active && !session.answeredAt) setCallSession({ answeredAt: at });
}

/** Both sides hanging up enter the same feedback step, retaining the lead and transcript. */
export function endDemoCall(endedBy = "agent") {
  if (!session.active) return false;
  setCallSession({ active: false, awaitingOutcome: true, endedAt: Date.now(), endedBy, trouble: "" });
  // The dialer records the calls it places in the CRM itself, so only demo and real calls go in the page's call log.
  if (session.mode === "dialer") return true;
  const call = { id: session.callId, leadId: session.lead.adHoc ? null : session.lead.id, name: session.lead.adHoc ? "" : session.lead.name, phone: session.lead.phone, startedAt: session.startedAt, endedAt: session.endedAt, endedBy };
  logListeners.forEach(listener => listener(call));
  return true;
}

export function clearCallOutcome() {
  setCallSession({ active: false, awaitingOutcome: false, callId: null, lead: null, transcript: [], startedAt: null, endedAt: null, endedBy: null, mode: "demo", serverCallId: null, answeredAt: null, trouble: "" });
}

let lineCounter = 0;
/** Adds one settled line of speech to the call's transcript. */
export function addTranscriptLine(line) {
  lineCounter += 1;
  setCallSession({ transcript: [...session.transcript, { id: lineCounter, ...line }].slice(-60) });
}

const subscribe = listener => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useCallSession = () => useSyncExternalStore(subscribe, getCallSession);
