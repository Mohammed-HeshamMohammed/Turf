// One way for every page to start, end and wrap up a call, whichever kind it is:
//   "dialer"  the dialer service places it (a signed-in workspace in a build with VITE_CALLERWHALE_DIALER_URL);
//   "real"    Option B: the browser calls one of the team's own phones through Telnyx (realCall.ts);
//   "demo"    nothing is dialled (the sample workspace, dial-pad numbers, or a build without a dialer).
// The dialer logs its calls in crm-core itself, so after a dialer call the page must not dispatch its own CALL.
// Every page (the Calls page, the phone pad, the call log) starts and ends calls here, never with callSession.ts directly.

import { beginDemoCall, beginServerCall, canBeginCall, clearCallOutcome, endDemoCall, getCallSession, markAnswered, setCallSession } from "./callSession.ts";
import { dialer as defaultDialer, dialerBase, toDialerOutcome } from "./remote/dialer.ts";
import { realCalls } from "./realCall.ts";

export type CallMode = "demo" | "dialer" | "real";
type Started = { ok: boolean; mode: CallMode; error?: string };

type RealCalls = {
  allowed: (phone: string) => boolean;
  start: (lead: any, events: { onAnswered: () => void; onEnded: (by: "agent" | "contact") => void }) => Promise<void>;
  hangup: () => void;
};

type Deps = {
  dialer: any;
  hasDialer: () => boolean;
  every: (ms: number, tick: () => void | Promise<void>) => () => void;
  real: RealCalls;
};

const POLL_MS = 1000;
// Questions in a row the dialer may leave unanswered before the call says its status is unknown.
const MISSES_BEFORE_TROUBLE = 3;
const TROUBLE = "The dialer is not answering, so this call's status is unknown. End call tries to hang it up.";

function everyInterval(ms: number, tick: () => void | Promise<void>) {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}

export function createCalling({ dialer, hasDialer, every, real }: Deps) {
  let stopWatching = () => {};
  // The call being placed now (the dialer or Telnyx has not answered yet). end() waits for it, so none is left running.
  let placing: Promise<Started> | null = null;

  function modeFor(state, lead): CallMode {
    // The sample workspace and numbers that are not a lead never dial anything.
    if (!lead || lead.adHoc || !state?.remote) return "demo";
    if (real.allowed(lead.phone)) return "real";
    return hasDialer() ? "dialer" : "demo";
  }

  /** Asks the dialer about the call every second until it ends. A slow answer never overlaps the next question. */
  function watch(id: string) {
    stopWatching();
    let asking = false;
    let misses = 0;
    const ours = () => getCallSession().serverCallId === id && getCallSession().active;
    const stop = every(POLL_MS, async () => {
      if (asking) return;
      asking = true;
      try {
        const call = await dialer.get(id);
        if (!ours()) return stop();
        misses = 0;
        if (getCallSession().trouble) setCallSession({ trouble: "" });
        if (call.answered_at) markAnswered(Date.parse(call.answered_at));
        if (call.ended_at) {
          stop();
          endDemoCall(call.hangup_source === "callee" ? "contact" : "agent");
        }
      } catch {
        // A missed answer is asked again on the next tick; several in a row are shown on the call.
        misses += 1;
        if (misses >= MISSES_BEFORE_TROUBLE && ours() && !getCallSession().trouble) setCallSession({ trouble: TROUBLE });
      } finally {
        asking = false;
      }
    });
    stopWatching = stop;
  }

  async function start(state, lead): Promise<Started> {
    const mode = modeFor(state, lead);
    if (placing || !canBeginCall(lead)) return { ok: false, mode, error: "Finish the current call first." };
    if (mode === "demo") return { ok: beginDemoCall(lead), mode };
    // The call rings on screen before the network answers, so no other call can start meanwhile.
    beginServerCall(lead, null, mode);
    placing = place(mode, lead, getCallSession().callId);
    try {
      return await placing;
    } finally {
      placing = null;
    }
  }

  async function place(mode: CallMode, lead, callId: string): Promise<Started> {
    const ours = () => getCallSession().callId === callId;
    try {
      if (mode === "real") {
        await real.start(lead, {
          onAnswered: () => {
            if (ours()) markAnswered();
          },
          onEnded: by => {
            if (ours() && getCallSession().active) endDemoCall(by);
          },
        });
        return { ok: true, mode };
      }
      const call = await dialer.place(lead.id);
      setCallSession({ serverCallId: call.id });
      watch(call.id);
      return { ok: true, mode };
    } catch (error: any) {
      // Nothing was placed, so the call this attempt put on screen comes off it.
      if (ours()) clearCallOutcome();
      return { ok: false, mode, error: error?.message || "The call did not start." };
    }
  }

  /** Hangs up. A hangup the dialer refuses leaves the call on screen and followed, and says why. */
  async function end(): Promise<{ ok: boolean; error?: string }> {
    // A call still being placed is hung up once it exists.
    if (placing) await placing;
    const { active, mode, serverCallId } = getCallSession();
    if (!active) return { ok: true };
    if (mode === "dialer" && serverCallId) {
      try {
        await dialer.hangup(serverCallId);
      } catch (error: any) {
        return { ok: false, error: error?.message || "The call did not end. Try again." };
      }
    }
    if (mode === "real") real.hangup();
    stopWatching();
    endDemoCall("agent");
    return { ok: true };
  }

  /**
   * Saves how the call went. logHere: true means the page logs the call itself (demo and real calls).
   * notice: the outcome was not saved because the dialer had already logged the call; the page says so and moves on.
   */
  async function wrapUp({ outcome, callbackAt = "", notes = "" }: { outcome: string; callbackAt?: string; notes?: string }): Promise<{ logHere: boolean; error?: string; notice?: string }> {
    const { mode, serverCallId } = getCallSession();
    if (mode !== "dialer" || !serverCallId) return { logHere: true };
    try {
      await dialer.wrapUp(serverCallId, { outcome, callbackAt, notes });
      return { logHere: false };
    } catch (error: any) {
      if (error?.status !== 409) return { logHere: false, error: error?.message || "The outcome was not saved. Try again." };
      // "Already logged": the dialer settled the call itself, from what the carrier saw (an unanswered call) or because the
      // wrap-up time ran out. An outcome left to the carrier is what it saved; any other is checked against the record.
      if (toDialerOutcome(outcome) === "auto") return { logHere: false };
      const logged = await dialer.get(serverCallId).catch(() => null);
      if (logged?.outcome === outcome) return { logHere: false };
      return { logHere: false, notice: `The dialer had already logged this call as ${logged?.outcome || "another outcome"}, so ${outcome} was not saved.` };
    }
  }

  return { modeFor, start, end, wrapUp };
}

// Real calls happen only in a build with VITE_CALLERWHALE_REAL_CALL_NUMBERS and a login token on the device (realCall.ts).
export const calling = createCalling({ dialer: defaultDialer, hasDialer: () => Boolean(dialerBase()), every: everyInterval, real: realCalls });
