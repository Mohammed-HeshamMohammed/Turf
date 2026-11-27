// One way for every page to start, end and wrap up a call, whichever kind it is:
//   "dialer"  the dialer service places it (a signed-in workspace in a build with VITE_CALLERWHALE_DIALER_URL);
//   "real"    Option B: the browser calls one of the team's own phones through Telnyx (realCall.ts);
//   "demo"    nothing is dialled (the sample workspace, dial-pad numbers, or a build without a dialer).
// The dialer logs its calls in crm-core itself, so after a dialer call the page must not dispatch its own CALL.

import { beginDemoCall, beginServerCall, canBeginCall, clearCallOutcome, endDemoCall, getCallSession, markAnswered } from "./callSession.ts";
import { dialer as defaultDialer, dialerBase } from "./remote/dialer.ts";

export type CallMode = "demo" | "dialer" | "real";

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

function everyInterval(ms: number, tick: () => void | Promise<void>) {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}

export function createCalling({ dialer, hasDialer, every, real }: Deps) {
  let stopWatching = () => {};
  let starting = false;

  function modeFor(state, lead): CallMode {
    if (!lead || lead.adHoc) return "demo";
    if (real.allowed(lead.phone)) return "real";
    if (state?.remote && hasDialer()) return "dialer";
    return "demo";
  }

  /** Asks the dialer about the call every second until it ends. A slow answer never overlaps the next question. */
  function watch(id: string) {
    stopWatching();
    let asking = false;
    const stop = every(POLL_MS, async () => {
      if (asking) return;
      asking = true;
      try {
        const call = await dialer.get(id);
        if (getCallSession().serverCallId !== id || !getCallSession().active) return stop();
        if (call.answered_at) markAnswered(Date.parse(call.answered_at));
        if (call.ended_at) {
          stop();
          endDemoCall(call.hangup_source === "callee" ? "contact" : "agent");
        }
      } catch {
        /* A missed answer is asked again on the next tick. */
      } finally {
        asking = false;
      }
    });
    stopWatching = stop;
  }

  async function start(state, lead): Promise<{ ok: boolean; mode: CallMode; error?: string }> {
    const mode = modeFor(state, lead);
    if (starting || !canBeginCall(lead)) return { ok: false, mode, error: "Finish the current call first." };
    if (mode === "demo") return { ok: beginDemoCall(lead), mode };
    starting = true;
    try {
      if (mode === "real") {
        beginServerCall(lead, null, "real");
        await real.start(lead, {
          onAnswered: () => markAnswered(),
          onEnded: by => {
            if (getCallSession().mode === "real" && getCallSession().active) endDemoCall(by);
          },
        });
        return { ok: true, mode };
      }
      const call = await dialer.place(lead.id);
      beginServerCall(lead, call.id, "dialer");
      watch(call.id);
      return { ok: true, mode };
    } catch (error: any) {
      // A call this attempt began (only a real call begins before the network answers) is taken off the screen.
      // The gate checks above guarantee no earlier call is pending here, so nothing else can be cleared by mistake.
      if (getCallSession().active && getCallSession().mode === mode) clearCallOutcome();
      return { ok: false, mode, error: error?.message || "The call did not start." };
    } finally {
      starting = false;
    }
  }

  async function end() {
    const { active, mode, serverCallId } = getCallSession();
    if (!active) return;
    stopWatching();
    if (mode === "dialer" && serverCallId) await dialer.hangup(serverCallId).catch(() => {});
    if (mode === "real") real.hangup();
    endDemoCall("agent");
  }

  /** Saves how the call went. logHere: true means the page logs the call itself (demo and real calls). */
  async function wrapUp({ outcome, callbackAt = "", notes = "" }: { outcome: string; callbackAt?: string; notes?: string }): Promise<{ logHere: boolean; error?: string }> {
    const { mode, serverCallId } = getCallSession();
    if (mode !== "dialer" || !serverCallId) return { logHere: true };
    try {
      await dialer.wrapUp(serverCallId, { outcome, callbackAt, notes });
      return { logHere: false };
    } catch (error: any) {
      // "Already logged": the dialer settled an unanswered call from what the carrier saw, as "auto" would have.
      if (error?.status === 409) return { logHere: false };
      return { logHere: false, error: error?.message || "The outcome was not saved. Try again." };
    }
  }

  return { modeFor, start, end, wrapUp };
}

// Option B replaces this with realCall.ts (Task 10). Until then no number is ever called for real.
const noRealCalls: RealCalls = { allowed: () => false, start: async () => {}, hangup: () => {} };

export const calling = createCalling({ dialer: defaultDialer, hasDialer: () => Boolean(dialerBase()), every: everyInterval, real: noRealCalls });
