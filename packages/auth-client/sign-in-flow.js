// The steps of signing in, with no screen of their own: the website and the CRM each draw their own, on this one set of rules.
// Email and password; when the account has a second step, choosing how to confirm (an authenticator, a code by email or
// Telegram, or an approval on another device), sending it, and answering. The step in progress is kept in this tab while the
// auth service keeps it (10 minutes), so a refresh comes back to it instead of the password.

const KEY = "callerwhale.auth.challenge";
const KEEP_MS = 9 * 60_000;
const SENDS = new Set(["email", "telegram", "push"]);

/**
 * @param {object} options
 * @param {ReturnType<import("./auth-client.js").createAuth>} options.auth
 * @param {() => Promise<string>} [options.humanToken] the human check's token for this sign-in ("" when it is off)
 * @param {() => void} [options.onSignedIn] called once the sign-in is complete
 * @param {string} [options.device] how an approval request names this device ("Caller Whale desktop app")
 */
export function createSignInFlow({ auth, humanToken = async () => "", onSignedIn = () => {}, device = "", storage = globalThis.sessionStorage, now = () => Date.now(), pollMs = 2000 }) {
  const fresh = () => ({ step: "password", challenge: "", methods: [], method: "", sent: false, busy: false, error: "", note: "" });
  let state = fresh();
  const listeners = new Set();
  let watch = null;

  const set = patch => {
    state = { ...state, ...patch };
    if (state.step === "second") keep();
    listeners.forEach(listener => listener());
  };
  const keep = () => {
    try {
      storage?.setItem(KEY, JSON.stringify({ challenge: state.challenge, methods: state.methods, method: state.method, sent: state.sent, at: now() }));
    } catch {
      /* the step then lasts until the page closes */
    }
  };
  const drop = () => {
    try {
      storage?.removeItem(KEY);
    } catch {
      /* nothing kept */
    }
  };
  const stopWatching = () => {
    clearInterval(watch);
    watch = null;
  };
  const finish = () => {
    stopWatching();
    drop();
    state = fresh();
    listeners.forEach(listener => listener());
    onSignedIn();
  };
  // A step auth no longer knows (expired, used up, denied): back to the password, saying why.
  const lost = error => {
    stopWatching();
    drop();
    set({ ...fresh(), error: error.message });
  };

  async function busy(work) {
    set({ busy: true, error: "", note: "" });
    try {
      await work();
    } catch (error) {
      if (error?.status === 403 && state.step === "second") return lost(error);
      set({ error: error?.message || "Sign-in did not work. Try again." });
    } finally {
      if (state.busy) set({ busy: false });
    }
  }

  function watchApproval() {
    stopWatching();
    watch = setInterval(async () => {
      try {
        const answer = await auth.approvalState(state.challenge);
        if (answer === "approved") {
          stopWatching();
          await auth.answer(state.challenge, "push");
          finish();
        } else if (answer === "denied" || answer === "expired") {
          stopWatching();
          set({ sent: false, error: answer === "denied" ? "The sign-in was denied on your other device." : "No one answered in time. Try again." });
        }
      } catch (error) {
        stopWatching();
        if (error?.status === 403) lost(error);
        else set({ error: error?.message || "Could not check the approval." });
      }
    }, pollMs);
  }

  const flow = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The step a refresh left behind in this tab, if it is still good. */
    restore() {
      try {
        const kept = JSON.parse(storage?.getItem(KEY) || "null");
        if (kept?.challenge && Array.isArray(kept.methods) && now() - kept.at < KEEP_MS) {
          set({ ...fresh(), step: "second", challenge: kept.challenge, methods: kept.methods, method: kept.method, sent: Boolean(kept.sent) });
          if (state.method === "push" && state.sent) watchApproval();
          return true;
        }
      } catch {
        /* nothing usable */
      }
      drop();
      return false;
    },

    /** Email and password. `kind` is "browser", "shared" (a shared device: kept only in this tab) or "desktop". */
    signIn: (email, password, { kind = "browser" } = {}) =>
      busy(async () => {
        try {
          await auth.signIn(String(email).trim(), password, undefined, kind, await humanToken());
        } catch (error) {
          if (error?.code !== "mfa_required") throw error;
          const methods = error.data?.methods || [];
          if (!error.data?.challenge || !methods.length) throw new Error("This account needs a second step that cannot be done here. Use the Caller Whale app.");
          const method = methods.includes("totp") ? "totp" : methods.find(m => m !== "push") || methods[0];
          set({ step: "second", challenge: error.data.challenge, methods, method, sent: false });
          // A code by email or Telegram is sent at once when it is the way to confirm; an approval is asked for by the person.
          if (method === "email" || method === "telegram") await flow.send();
          return;
        }
        finish();
      }),

    /** A second step that started elsewhere (coming back from Google, or a step-up on a session): confirm it here. */
    begin({ challenge, methods } = {}) {
      if (!challenge || !methods?.length) return;
      stopWatching();
      const method = methods.includes("totp") ? "totp" : methods.find(m => m !== "push") || methods[0];
      set({ ...fresh(), step: "second", challenge, methods, method });
    },

    /** Another way to confirm, among those auth offered. */
    choose(method) {
      if (!state.methods.includes(method) || method === state.method) return;
      stopWatching();
      set({ method, sent: false, error: "", note: "" });
    },

    /** Sends the code (email, Telegram), or asks the other device to approve (push). */
    send: () =>
      busy(async () => {
        if (!SENDS.has(state.method)) return;
        await auth.sendCode(state.challenge, state.method, state.method === "push" ? device || undefined : undefined);
        set({ sent: true, note: state.method === "push" ? "Open Caller Whale on your other device and approve this sign-in." : `We sent a code by ${state.method}.` });
        if (state.method === "push") watchApproval();
      }),

    /** The code from the authenticator, the email or Telegram. */
    answer: code =>
      busy(async () => {
        await auth.answer(state.challenge, state.method, String(code).trim());
        finish();
      }),

    /** Back to the password (another account, or start again). */
    back() {
      stopWatching();
      drop();
      set(fresh());
    },

    /** The page is going away: stop asking about an approval. The step stays kept for a refresh. */
    stop: stopWatching,
  };
  return flow;
}

/** What the screen should ask for now: a code box, a send button, or waiting for the other device. */
export function needsCode(state) {
  return state.method === "totp" || ((state.method === "email" || state.method === "telegram") && state.sent);
}
