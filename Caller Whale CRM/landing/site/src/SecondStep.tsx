import { useEffect, useState, type FormEvent } from "react";
import type { Auth } from "@callerwhale/auth-client";

/** An error from the staff API that keeps the service's own code (like "step_up_required"), so a screen can act on it. */
export class ApiError extends Error {
  code: string;
  constructor(message: string, code = "") {
    super(message);
    this.code = code;
  }
}

export const needsSecondStep = (error: unknown) => error instanceof ApiError && error.code === "step_up_required";

/**
 * For an action that needs a second step done just now. `guard(action)` runs it; if the service says a code is needed, the code
 * box appears in `prompt` and, once the code is accepted, the same action runs again. Any other error is the action's own to handle.
 */
export function useSecondStep(auth: Auth, reason = "This needs a code entered just now.") {
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const guard = async (action: () => Promise<void>) => {
    try { await action(); } catch (error) {
      if (needsSecondStep(error)) setPending(() => action);
      else throw error;
    }
  };
  const prompt = pending ? <SecondStep auth={auth} reason={reason} onCancel={() => setPending(null)} onDone={() => { const again = pending; setPending(null); void guard(again); }} /> : null;
  return { guard, prompt };
}

/**
 * Asks for a fresh authenticator code (or the code sent by email or Telegram) in place, for the actions that need a second step done
 * just now. The sixth digit sends it by itself. When it is accepted the session carries the new confirmation and `onDone` runs,
 * so the screen can carry on with what the person was doing.
 */
export function SecondStep({ auth, onDone, onCancel, reason }: { auth: Auth; onDone: () => void; onCancel?: () => void; reason?: string }) {
  const [challenge, setChallenge] = useState<{ id: string; method: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const started = (await auth.startStepUp()) as { challenge: string; methods: string[] };
        const method = started.methods.includes("totp") ? "totp" : started.methods.find(m => m === "email" || m === "telegram");
        if (!method) { if (live) setMessage("This account needs a second step this page cannot do yet. Use the Caller Whale app."); return; }
        if (method !== "totp") await auth.sendCode(started.challenge, method);
        if (live) setChallenge({ id: started.challenge, method });
      } catch (error) {
        if (live) setMessage(error instanceof Error ? error.message : "Could not start the check. Try again.");
      }
    })();
    return () => { live = false; };
  }, [auth]);

  const submit = async (value: string) => {
    if (!challenge || busy) return;
    setBusy(true); setMessage("");
    try {
      await auth.answer(challenge.id, challenge.method, value);
      onDone();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That code did not work.");
      setCode("");
    }
    setBusy(false);
  };

  return <form className="staff-code-form" onSubmit={(event: FormEvent) => { event.preventDefault(); if (code.trim()) void submit(code.trim()); }}>
    <h3>Confirm it's you</h3>
    <p className="muted">{reason ? `${reason} ` : ""}{challenge && challenge.method !== "totp" ? `Enter the code we sent you by ${challenge.method}.` : "Enter the 6-digit code from your authenticator app."}</p>
    <div className="staff-code-row">
      <input inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={6} placeholder="000000" aria-label="Six-digit code" value={code} disabled={!challenge || busy}
        onChange={event => { const value = event.target.value.replace(/\D/g, "").slice(0, 6); setCode(value); if (value.length === 6) void submit(value); }} />
      <button className="button primary" disabled={!challenge || busy}>{busy ? "Checking…" : "Verify"}</button>
      {onCancel && <button type="button" className="button raised" disabled={busy} onClick={onCancel}>Cancel</button>}
    </div>
    {message && <p className="notice bad" role="alert">{message}</p>}
  </form>;
}
