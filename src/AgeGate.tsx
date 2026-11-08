import { useState, type FormEvent } from "react";
import type { Auth } from "./auth/auth-client.js";
import { ageProblem } from "./age.ts";
import { BirthDateField } from "./BirthDate.tsx";

/** Shown instead of the account pages to a signed-in person who has not given their date of birth. Caller Whale is for adults. */
export function AgeGate({ auth, onDone, onSignOut }: { auth: Auth; onDone: () => void; onSignOut: () => void }) {
  const [birth, setBirth] = useState("");
  const [state, setState] = useState({ busy: false, error: "" });
  const problem = ageProblem(birth);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem) return;
    setState({ busy: true, error: "" });
    try {
      await auth.setBirthDate(birth);
      onDone();
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : "Could not save your date of birth." });
    }
  };
  return (
    <div className="form-wrap">
      <form className="form card" onSubmit={submit}>
        <h1>Confirm your age</h1>
        <p className="muted">Caller Whale is for people aged 18 or older. Enter your date of birth to continue. It is kept on your account and cannot be changed later.</p>
        <BirthDateField value={birth} onChange={setBirth} />
        {(problem || state.error) && <p className="notice bad" role="alert">{problem || state.error}</p>}
        <button className="button primary" disabled={state.busy || !birth || Boolean(problem)}>
          {state.busy ? <><span className="spinner" aria-hidden="true" />Saving…</> : "Continue"}
        </button>
        <button type="button" className="text-button" onClick={onSignOut}>Sign out</button>
      </form>
    </div>
  );
}
