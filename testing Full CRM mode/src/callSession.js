import { useSyncExternalStore } from "react";

// What a running call shares with the rest of the app: whether captions are on, whether a call is live and who it is with.
// It lives outside any page so the call, and its caption bar, carry on while you move around the app.
const CAPTIONS_KEY = "turf.full-crm.captions";

function readCaptions() {
  try {
    return window.localStorage.getItem(CAPTIONS_KEY) === "on";
  } catch {
    return false;
  }
}

let session = { captions: readCaptions(), active: false, lead: null };
const listeners = new Set();

export const getCallSession = () => session;

export function setCallSession(patch) {
  session = { ...session, ...patch };
  if ("captions" in patch) {
    try {
      window.localStorage.setItem(CAPTIONS_KEY, session.captions ? "on" : "off");
    } catch {
      /* The switch still works for this session. */
    }
  }
  listeners.forEach(listener => listener());
}

const subscribe = listener => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useCallSession = () => useSyncExternalStore(subscribe, getCallSession);
