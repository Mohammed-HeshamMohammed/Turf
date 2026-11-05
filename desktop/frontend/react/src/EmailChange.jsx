import { useEffect, useRef, useState } from "react";
import { CheckCircle, EnvelopeSimple, ShieldCheck } from "@phosphor-icons/react";
import { Badge, Button, Field } from "./ui.jsx";

const CODE_LENGTH = 6;
const LIFETIME = 10 * 60 * 1000;
const RESEND_AFTER = 30 * 1000;
const MAX_TRIES = 5;

const newCode = () => String(Math.floor(Math.random() * 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
const mmss = ms => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
};

/**
 * Changing the sign-in email never swaps it immediately: the new address is held as "pending" until the person
 * enters the code sent to it. The preview sends nothing, so the code is shown in a demo inbox instead.
 */
export function EmailChange({ profile, dispatch, notify }) {
  const pending = profile.pendingEmail;
  const [draft, setDraft] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const codeField = useRef(null);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  const normalized = draft.trim().toLowerCase();
  const draftError =
    normalized && normalized === profile.email.toLowerCase()
      ? "That is already your email address."
      : normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized)
        ? "Enter a complete email address."
        : "";

  function send(address) {
    dispatch({ type: "PERSONAL", profile: { pendingEmail: { address, code: newCode(), sentAt: Date.now(), tries: 0 } } });
    setCode("");
    setError("");
    setNow(Date.now());
    setTimeout(() => codeField.current?.focus(), 50);
  }
  function verify(event) {
    event.preventDefault();
    if (now - pending.sentAt > LIFETIME) return setError("This code has expired. Send a new one.");
    if (pending.tries >= MAX_TRIES) return setError("Too many attempts. Send a new code.");
    if (code.trim() !== pending.code) {
      dispatch({ type: "PERSONAL", profile: { pendingEmail: { ...pending, tries: pending.tries + 1 } } });
      const left = MAX_TRIES - pending.tries - 1;
      return setError(left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many attempts. Send a new code.");
    }
    dispatch({ type: "PERSONAL", profile: { email: pending.address, pendingEmail: null } });
    setDraft("");
    setError("");
    notify("Email address verified and updated");
  }

  if (pending) {
    const remaining = pending.sentAt + LIFETIME - now;
    const wait = pending.sentAt + RESEND_AFTER - now;
    const expired = remaining <= 0 || pending.tries >= MAX_TRIES;
    return (
      <div className="email-change" aria-live="polite">
        <div className="email-current">
          <small>Current email</small>
          <strong>{profile.email}</strong>
          <Badge tone="good">Verified</Badge>
        </div>
        <div className="email-pending">
          <header>
            <EnvelopeSimple size={22} weight="light" />
            <div>
              <strong>Check {pending.address}</strong>
              <small>
                We sent a {CODE_LENGTH}-digit code. Your email stays {profile.email} until it is confirmed.
              </small>
            </div>
          </header>
          <form onSubmit={verify}>
            <Field label="Verification code" help={expired ? "This code can no longer be used." : "Expires in " + mmss(remaining)}>
              <input
                ref={codeField}
                value={code}
                onChange={event => {
                  setCode(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH));
                  setError("");
                }}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                className="code-input"
                aria-invalid={Boolean(error)}
                disabled={expired}
              />
            </Field>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="email-actions">
              <button className="button primary" type="submit" disabled={expired || code.length < CODE_LENGTH}>
                <ShieldCheck size={17} />
                <span>Verify email</span>
              </button>
              <Button disabled={wait > 0 && !expired} onClick={() => send(pending.address)}>
                {wait > 0 && !expired ? "Resend in " + Math.ceil(wait / 1000) + "s" : "Send a new code"}
              </Button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  dispatch({ type: "PERSONAL", profile: { pendingEmail: null } });
                  setCode("");
                  setError("");
                }}
              >
                Cancel change
              </button>
            </div>
          </form>
          <p className="demo-inbox">
            <strong>Demo inbox</strong> · nothing is emailed from this preview. Your code is <code>{pending.code}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      className="email-change"
      onSubmit={event => {
        event.preventDefault();
        if (normalized && !draftError) send(normalized);
      }}
    >
      <Field label="Email address" help="Changing it asks you to confirm the new address first.">
        <input type="email" value={draft} onChange={event => setDraft(event.target.value)} placeholder={profile.email} aria-invalid={Boolean(draftError)} />
      </Field>
      <div className="email-current">
        <CheckCircle size={16} weight="fill" />
        <span>
          {profile.email} · <strong>verified</strong>
        </span>
      </div>
      {draftError && (
        <p className="field-error" role="alert">
          {draftError}
        </p>
      )}
      <Button type="submit" disabled={!normalized || Boolean(draftError)}>
        Send verification code
      </Button>
    </form>
  );
}
