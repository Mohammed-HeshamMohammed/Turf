// Option B: a real call from the browser to one of the team's own phones, through a Telnyx Trial account.
// A demo shortcut: the browser places the call itself with a short-lived login token. In production the dialer places
// the call and joins the caller to it. The dialer never sees these calls, so the page logs them.
// Safety: only numbers listed at build time (VITE_CALLERWHALE_REAL_CALL_NUMBERS) are ever called, and the Trial account
// itself refuses every number except its one verified phone.

import { phoneNumberKey } from "./phone.ts";

const TOKEN_KEY = "callerwhale.realcall.token";
const AUDIO_ID = "callerwhale-remote-audio";
// How long Telnyx may take to accept the login. Ending a call waits for a call still connecting, so this must end.
const CONNECT_MS = 15000;

const listed = (): string[] =>
  String(import.meta.env?.VITE_CALLERWHALE_REAL_CALL_NUMBERS || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);

/** The short-lived login token the presenter saved on this device under TOKEN_KEY. */
export function savedToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

/** True only for a listed team phone, and only once a login token is on this device. */
export function mayCallForReal(phone: string, { numbers = listed(), token = savedToken() }: { numbers?: string[]; token?: string } = {}): boolean {
  if (!token || !phone) return false;
  const key = phoneNumberKey(phone);
  return numbers.some(item => phoneNumberKey(item) === key);
}

type Handlers = { onAnswered: () => void; onEnded: (by: "agent" | "contact") => void };

let client: any = null;
let current: any = null;
let endingHere = false;
let handlers: Handlers | null = null;

async function connect(): Promise<any> {
  if (client) return client;
  // Loaded only when a real call starts, so the normal app never downloads the SDK.
  const { TelnyxRTC } = await import("@telnyx/webrtc");
  const rtc: any = new TelnyxRTC({ login_token: savedToken() });
  rtc.remoteElement = AUDIO_ID;
  rtc.on("telnyx.notification", (notification: any) => {
    if (notification.type !== "callUpdate" || notification.call !== current) return;
    const state = notification.call.state;
    if (state === "active") handlers?.onAnswered();
    if (state === "hangup" || state === "destroy") {
      const by = endingHere ? "agent" : "contact";
      current = null;
      endingHere = false;
      handlers?.onEnded(by);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      rtc.disconnect?.();
      reject(new Error("Telnyx did not answer. Check the connection and try again."));
    }, CONNECT_MS);
    rtc.on("telnyx.ready", () => {
      clearTimeout(timer);
      resolve();
    });
    rtc.on("telnyx.error", (error: any) => {
      clearTimeout(timer);
      reject(new Error(error?.message || "Telnyx refused the login. Mint a new token."));
    });
    rtc.connect();
  });
  client = rtc;
  return rtc;
}

export const realCalls = {
  allowed: (phone: string) => mayCallForReal(phone),
  start: async (lead: any, events: Handlers) => {
    handlers = events;
    const rtc = await connect();
    endingHere = false;
    current = rtc.newCall({
      destinationNumber: "+" + String(lead.phone).replace(/\D/g, ""),
      callerNumber: String(import.meta.env?.VITE_CALLERWHALE_REAL_CALL_FROM || ""),
      audio: true,
      video: false,
    });
  },
  hangup: () => {
    endingHere = true;
    current?.hangup();
  },
};
