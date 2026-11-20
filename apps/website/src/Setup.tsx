import { useState, type FormEvent } from "react";
import type { Auth, Me } from "@callerwhale/auth-client";
import { AgeGate } from "./AgeGate.tsx";
import { TEAM_SIZES, TERMS_VERSION, WORK_ROLES, WORK_USES, setupStep } from "./setup.ts";

/** Shown instead of the account pages while an account still has a setup step to do: age, then the terms, then its work. */
export function Setup({ me, auth, onDone, onSignOut }: { me: Me; auth: Auth; onDone: () => void; onSignOut: () => void }) {
  const step = setupStep(me);
  if (step === "age") return <AgeGate auth={auth} onDone={onDone} onSignOut={onSignOut} />;
  if (step === "terms") return <TermsStep auth={auth} onDone={onDone} onSignOut={onSignOut} />;
  return <WorkStep auth={auth} onDone={onDone} onSignOut={onSignOut} />;
}

function useStep() {
  const [state, setState] = useState({ busy: false, error: "" });
  const run = async (work: () => Promise<unknown>, done: () => void) => {
    setState({ busy: true, error: "" });
    try { await work(); done(); }
    catch (error) { setState({ busy: false, error: error instanceof Error ? error.message : "Could not save. Try again." }); }
  };
  return [state, run] as const;
}

const Busy = ({ busy, label }: { busy: boolean; label: string }) => busy ? <><span className="spinner" aria-hidden="true" />Saving…</> : <>{label}</>;

function TermsStep({ auth, onDone, onSignOut }: { auth: Auth; onDone: () => void; onSignOut: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [state, run] = useStep();
  const submit = (event: FormEvent) => { event.preventDefault(); if (agreed) void run(() => auth.acceptTerms(TERMS_VERSION), onDone); };
  return (
    <div className="form-wrap">
      <form className="form card" onSubmit={submit}>
        <h1>Terms and privacy</h1>
        <p className="muted">Please read and accept them to continue.</p>
        <label className="check"><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} /> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
        {state.error && <p className="notice bad" role="alert">{state.error}</p>}
        <button className="button primary" disabled={!agreed || state.busy}><Busy busy={state.busy} label="Continue" /></button>
        <button type="button" className="text-button" onClick={onSignOut}>Sign out</button>
      </form>
    </div>
  );
}

function WorkStep({ auth, onDone, onSignOut }: { auth: Auth; onDone: () => void; onSignOut: () => void }) {
  const [role, setRole] = useState("");
  const [size, setSize] = useState("");
  const [uses, setUses] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [state, run] = useStep();
  const ready = role !== "" && size !== "" && uses.length > 0 && (role !== "other" || other.trim() !== "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) void run(() => auth.setWorkProfile({ role, team_size: size, uses, other: other.trim() }), onDone);
  };
  return (
    <div className="form-wrap">
      <form className="form card setup-work" onSubmit={submit}>
        <h1>Tell us about your work</h1>
        <p className="muted">So we can set Caller Whale up to fit you. It takes a minute.</p>
        <fieldset className="choice-group"><legend>What describes you best?</legend>
          {WORK_ROLES.map(item => (
            <label key={item.key} className={`choice${role === item.key ? " is-chosen" : ""}`}>
              <input type="radio" name="role" value={item.key} checked={role === item.key} onChange={() => setRole(item.key)} />
              <span><strong>{item.label}</strong><small>{item.help}</small></span>
            </label>
          ))}
        </fieldset>
        {role === "other" && <div className="field"><label>Your work<input maxLength={200} value={other} onChange={event => setOther(event.target.value)} placeholder="For example: roofing leads" style={{ width: "100%", marginTop: 6 }} /></label></div>}
        <fieldset className="choice-group"><legend>How big is your team?</legend>
          <div className="choice-row">
            {TEAM_SIZES.map(item => (
              <label key={item.key} className={`choice${size === item.key ? " is-chosen" : ""}`}>
                <input type="radio" name="size" value={item.key} checked={size === item.key} onChange={() => setSize(item.key)} />
                <span><strong>{item.label}</strong></span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="choice-group"><legend>What will you use it for? Choose all that apply.</legend>
          <div className="choice-row">
            {WORK_USES.map(item => (
              <label key={item.key} className={`choice${uses.includes(item.key) ? " is-chosen" : ""}`}>
                <input type="checkbox" checked={uses.includes(item.key)} onChange={event => setUses(event.target.checked ? [...uses, item.key] : uses.filter(key => key !== item.key))} />
                <span><strong>{item.label}</strong></span>
              </label>
            ))}
          </div>
        </fieldset>
        {state.error && <p className="notice bad" role="alert">{state.error}</p>}
        <button className="button primary" disabled={!ready || state.busy}><Busy busy={state.busy} label="Finish" /></button>
        <button type="button" className="text-button" onClick={onSignOut}>Sign out</button>
      </form>
    </div>
  );
}
