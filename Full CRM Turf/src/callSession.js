import { useSyncExternalStore } from "react";

// What a running call shares with the rest of the app: whether captions are on, whether a call is live, who it is with,
// and what has been said so far. It lives outside any page so the call, its caption bar and the assistant carry on
// while you move around the app (and so a pop-out window can mirror it).
const CAPTIONS_KEY = "turf.full-crm.captions";
const SOURCE_KEY = "turf.full-crm.captions-source";

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
  awaitingOutcome: false,
  startedAt: null,
  endedAt: null,
  endedBy: null,
  lead: null,
  // Settled lines, oldest first: { id, who, side, text }.
  transcript: [],
};
const listeners = new Set();

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

/** Starting another call is blocked until the current call's outcome has been saved. */
export function beginDemoCall(lead) {
  if (session.active || session.awaitingOutcome || !lead?.phone?.trim()) return false;
  setCallSession({
    active: true,
    awaitingOutcome: false,
    lead: { id: lead.id, name: lead.name, address: lead.address, motivation: lead.motivation },
    startedAt: Date.now(),
    endedAt: null,
    endedBy: null,
    transcript: [],
  });
  return true;
}

/** Both sides hanging up enter the same feedback step, retaining the lead and transcript. */
export function endDemoCall(endedBy = "agent") {
  if (!session.active) return false;
  setCallSession({ active: false, awaitingOutcome: true, endedAt: Date.now(), endedBy });
  return true;
}

export function clearCallOutcome() {
  setCallSession({ active: false, awaitingOutcome: false, lead: null, transcript: [], startedAt: null, endedAt: null, endedBy: null });
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
