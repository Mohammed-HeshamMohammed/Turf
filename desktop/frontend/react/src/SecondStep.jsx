import { useEffect, useRef, useState } from "react";
import { DeviceMobile, EnvelopeSimple, PaperPlaneTilt, ShieldCheck, TelegramLogo } from "@phosphor-icons/react";
import { Button, Field } from "./ui.jsx";

// The second step after the password (docs/plans/second-factor.md): choose how to confirm it is you, then confirm. The auth
// service offers only the ways this person has, and decides whether the answer is right.

const NAMES = { totp: "Authenticator app", email: "Email", telegram: "Telegram", push: "Approve on another device" };
const ICONS = { totp: ShieldCheck, email: EnvelopeSimple, telegram: TelegramLogo, push: DeviceMobile };

export function SecondStep({ auth, challenge, methods, onDone, onBack }) {
  const [method, setMethod] = useState(methods.includes("totp") ? "totp" : methods[0]);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [state, setState] = useState({ busy: false, error: "", note: "" });
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const run = async work => {
    setState({ busy: true, error: "", note: "" });
    try {
      await work();
    } catch (error) {
      if (alive.current) setState({ busy: false, error: error.message, note: "" });
      return;
    }
    if (alive.current) setState(s => ({ ...s, busy: false }));
  };

  // An approval on another device: asked once, then watched until it is answered.
  useEffect(() => {
    if (method !== "push" || !sent) return undefined;
    let live = true;
    const watch = setInterval(async () => {
      try {
        const answer = await auth.approvalState(challenge);
        if (!live) return;
        if (answer === "approved") {
          clearInterval(watch);
          await auth.answer(challenge, "push");
          if (live) onDone();
        } else if (answer === "denied" || answer === "expired") {
          clearInterval(watch);
          setSent(false);
          setState({ busy: false, error: answer === "denied" ? "The sign-in was denied on your other device." : "No one answered in time. Try again.", note: "" });
        }
      } catch (error) {
        if (live) {
          clearInterval(watch);
          setState({ busy: false, error: error.message, note: "" });
        }
      }
    }, 2000);
    return () => {
      live = false;
      clearInterval(watch);
    };
  }, [method, sent, challenge, auth, onDone]);

  const choose = next => {
    setMethod(next);
    setSent(false);
    setCode("");
    setState({ busy: false, error: "", note: "" });
  };
  const send = () =>
    run(async () => {
      await auth.sendCode(challenge, method, method === "push" ? "Caller Whale desktop app" : undefined);
      setSent(true);
      setState({ busy: false, error: "", note: method === "push" ? "Open Caller Whale on your other device and approve this sign-in." : `We sent a code by ${NAMES[method].toLowerCase()}.` });
    });
  const confirm = event => {
    event.preventDefault();
    run(async () => {
      await auth.answer(challenge, method, code.trim());
      onDone();
    });
  };
  const needsCode = method === "totp" || ((method === "email" || method === "telegram") && sent);

  return (
    <div className="remote-step second-step">
      <p className="body-copy">Confirm it is you.</p>
      {methods.length > 1 && (
        <div className="row" role="group" aria-label="How to confirm">
          {methods.map(item => {
            const Icon = ICONS[item];
            return (
              <Button key={item} icon={Icon} aria-pressed={method === item} onClick={() => choose(item)}>
                {NAMES[item]}
              </Button>
            );
          })}
        </div>
      )}
      <form onSubmit={confirm}>
        {method === "totp" && <p className="muted">Enter the code your authenticator app shows.</p>}
        {(method === "email" || method === "telegram") && !sent && <p className="muted">We will send a six-digit code by {NAMES[method].toLowerCase()}.</p>}
        {needsCode && (
          <Field label="Code">
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} required autoFocus />
          </Field>
        )}
        {state.error && <p className="error" role="alert">{state.error}</p>}
        {state.note && <p className="muted" role="status">{state.note}</p>}
        <div className="row">
          {needsCode ? (
            <>
              <Button type="submit" variant="primary" icon={ShieldCheck} disabled={state.busy || !code.trim()}>
                {state.busy ? "One moment…" : "Confirm"}
              </Button>
              {method !== "totp" && (
                <Button disabled={state.busy} onClick={send}>
                  Send again
                </Button>
              )}
            </>
          ) : (
            <Button variant="primary" icon={PaperPlaneTilt} disabled={state.busy || (method === "push" && sent)} onClick={send}>
              {method === "push" ? (sent ? "Waiting for approval…" : "Ask my other device") : "Send me a code"}
            </Button>
          )}
          {onBack && <Button onClick={onBack}>Back</Button>}
        </div>
      </form>
    </div>
  );
}

/** Sign-in requests waiting for this device to approve; shown while this device itself passed a second step. */
export function Approvals({ auth }) {
  const [waiting, setWaiting] = useState([]);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const rows = await auth.approvals();
        if (live) setWaiting(rows);
      } catch {
        if (live) setWaiting([]);
      }
    };
    poll();
    const timer = setInterval(poll, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [auth]);
  const answer = async (item, approve) => {
    setWaiting(rows => rows.filter(row => row.id !== item.id));
    await auth.decide(item.id, approve).catch(() => undefined);
  };
  if (!waiting.length) return null;
  return (
    <div className="approval-banner" role="alert">
      {waiting.map(item => (
        <div key={item.id} className="row">
          <p className="body-copy">
            <DeviceMobile size={18} /> <strong>{item.device || "A new device"}</strong> is trying to sign in to your account. Is this you?
          </p>
          <Button variant="primary" onClick={() => answer(item, true)}>
            Yes, approve
          </Button>
          <Button onClick={() => answer(item, false)}>No, deny</Button>
        </div>
      ))}
    </div>
  );
}
