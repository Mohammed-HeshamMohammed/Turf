import { useEffect, useState } from "react";
import { DeviceMobile, EnvelopeSimple, PaperPlaneTilt, ShieldCheck, TelegramLogo } from "@phosphor-icons/react";
import { needsCode } from "@callerwhale/auth-client/sign-in-flow.jsx";
import { Button, Field } from "./ui.jsx";

// The second step after the password, drawn the CRM's way. The steps themselves (which way,
// sending, answering, waiting for an approval, coming back after a refresh) are shared with the website: the `flow` from
// useSignInFlow (@callerwhale/auth-client/sign-in-flow.jsx). The auth service offers only the ways this person has.

const NAMES = { totp: "Authenticator app", email: "Email", telegram: "Telegram", push: "Approve on another device" };
const ICONS = { totp: ShieldCheck, email: EnvelopeSimple, telegram: TelegramLogo, push: DeviceMobile };

export function SecondStep({ state, flow, onBack }) {
  const [code, setCode] = useState("");
  const { method, methods, sent, busy, error, note } = state;
  useEffect(() => setCode(""), [method]);
  const confirm = event => {
    event.preventDefault();
    if (code.trim()) flow.answer(code);
  };
  const asksCode = needsCode(state);

  return (
    <div className="remote-step second-step">
      <p className="body-copy">Confirm it is you.</p>
      {methods.length > 1 && (
        <div className="row" role="group" aria-label="How to confirm">
          {methods.map(item => {
            const Icon = ICONS[item];
            return (
              <Button key={item} icon={Icon} aria-pressed={method === item} onClick={() => flow.choose(item)}>
                {NAMES[item]}
              </Button>
            );
          })}
        </div>
      )}
      <form onSubmit={confirm}>
        {method === "totp" && <p className="muted">Enter the code your authenticator app shows.</p>}
        {(method === "email" || method === "telegram") && !sent && <p className="muted">We will send a six-digit code by {NAMES[method].toLowerCase()}.</p>}
        {asksCode && (
          <Field label="Code">
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} required autoFocus />
          </Field>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {note && <p className="muted" role="status">{note}</p>}
        <div className="row">
          {asksCode ? (
            <>
              <Button type="submit" variant="primary" icon={ShieldCheck} disabled={busy || !code.trim()}>
                {busy ? "One moment…" : "Confirm"}
              </Button>
              {method !== "totp" && (
                <Button disabled={busy} onClick={() => flow.send()}>
                  Send again
                </Button>
              )}
            </>
          ) : (
            <Button variant="primary" icon={PaperPlaneTilt} disabled={busy || (method === "push" && sent)} onClick={() => flow.send()}>
              {method === "push" ? (sent ? "Waiting for approval…" : "Ask my other device") : "Send me a code"}
            </Button>
          )}
          {onBack && <Button onClick={onBack}>Back</Button>}
        </div>
      </form>
    </div>
  );
}

/**
 * Sign-in requests waiting for this device to approve; shown while this device itself passed a second step. The desktop app
 * asks every few seconds even when its window is in the background, since the request only lasts five minutes.
 */
export function Approvals({ auth }) {
  const [waiting, setWaiting] = useState([]);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const rows = await auth.approvals();
        if (live) setWaiting(rows);
      } catch {
        if (live) setWaiting([]);
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
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
