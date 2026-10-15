import { useEffect, useState } from "react";
import { Lock, ShieldCheck, SignIn, WifiSlash } from "@phosphor-icons/react";
import { api, apiBase, ApiError, setApiBase } from "./remote/api.js";
import { MemoryVault, Vault } from "./remote/vault.js";
import { Button, Card, Field } from "./ui.jsx";

/**
 * Signs in to a Turf server and unlocks this device's offline copy, then hands the session to the app.
 * Steps: server address → email/password → MFA code (or enrolment for owners and administrators) → offline passphrase.
 */
export function RemoteGate({ onReady, onLeave }) {
  const [step, setStep] = useState("checking");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState(null);
  const [enrolment, setEnrolment] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [form, setForm] = useState({ url: apiBase(), email: "", password: "", code: "", passphrase: "" });
  const field = name => event => setForm({ ...form, [name]: event.target.value });

  async function check() {
    try {
      const identity = await api.me();
      setMe(identity);
      if (identity.mfa.required && !identity.mfa.passed) setStep(identity.mfa.enrolled ? "mfa" : "enroll");
      else setStep("unlock");
    } catch (reason) {
      setStep(reason instanceof ApiError && reason.code === "offline" ? "offline" : "signin");
    }
  }
  useEffect(() => {
    check();
  }, []);

  async function attempt(work) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  const signIn = event => {
    event.preventDefault();
    attempt(async () => {
      setApiBase(form.url.trim());
      await api.login(form.email.trim(), form.password);
      setForm(current => ({ ...current, password: "" }));
      await check();
    });
  };
  const verify = event => {
    event.preventDefault();
    attempt(async () => {
      await api.verifyMfa(form.code.trim());
      await check();
    });
  };
  const startEnrolment = () => attempt(async () => setEnrolment(await api.setupMfa()));
  const confirmEnrolment = event => {
    event.preventDefault();
    attempt(async () => {
      const result = await api.confirmMfa(form.code.trim());
      setRecovery(result.recovery_codes);
    });
  };
  const unlock = (event, withPassphrase) => {
    event?.preventDefault();
    attempt(async () => {
      const vault = withPassphrase ? await Vault.unlock(form.passphrase, me.user.id + ":" + me.organization_id) : new MemoryVault();
      setForm(current => ({ ...current, passphrase: "" }));
      onReady({ me, vault, persistent: withPassphrase });
    });
  };

  return (
    <div className="remote-gate">
      <Card
        title={step === "unlock" ? "Keep an offline copy on this device?" : "Sign in to your Turf workspace"}
        subtitle={step === "unlock" ? "Records and pending changes are encrypted with a passphrase only you know." : "Your records stay on your organization's server."}
      >
        {step === "checking" && <p className="muted">Checking your session…</p>}
        {step === "offline" && (
          <div className="remote-step">
            <p className="notice">
              <WifiSlash size={18} /> The server at {apiBase() || "(not set)"} cannot be reached.
            </p>
            <div className="row">
              <Button variant="primary" onClick={() => attempt(check)}>
                Try again
              </Button>
              <Button onClick={() => setStep("signin")}>Change server</Button>
            </div>
          </div>
        )}
        {step === "signin" && (
          <form className="remote-step" onSubmit={signIn}>
            <Field label="Server address" help="For example https://crm.example.com">
              <input value={form.url} onChange={field("url")} placeholder="https://" required />
            </Field>
            <Field label="Email">
              <input type="email" autoComplete="username" value={form.email} onChange={field("email")} required />
            </Field>
            <Field label="Password">
              <input type="password" autoComplete="current-password" value={form.password} onChange={field("password")} required />
            </Field>
            <Button type="submit" variant="primary" icon={SignIn} disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        )}
        {step === "mfa" && (
          <form className="remote-step" onSubmit={verify}>
            <p className="body-copy">Enter the six-digit code from your authenticator app, or one of your recovery codes.</p>
            <Field label="Sign-in code">
              <input inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={field("code")} required />
            </Field>
            <Button type="submit" variant="primary" icon={ShieldCheck} disabled={busy}>
              Confirm
            </Button>
          </form>
        )}
        {step === "enroll" && !recovery && (
          <div className="remote-step">
            <p className="body-copy">Your role needs a second sign-in step. Add Turf to an authenticator app, then enter the code it shows.</p>
            {!enrolment ? (
              <Button variant="primary" icon={ShieldCheck} disabled={busy} onClick={startEnrolment}>
                Set up an authenticator
              </Button>
            ) : (
              <form onSubmit={confirmEnrolment}>
                <Field label="Setup key" help="Type this key into your authenticator app.">
                  <input readOnly value={enrolment.secret} onFocus={event => event.target.select()} />
                </Field>
                <Field label="Code from the app">
                  <input inputMode="numeric" value={form.code} onChange={field("code")} required />
                </Field>
                <Button type="submit" variant="primary" disabled={busy}>
                  Confirm
                </Button>
              </form>
            )}
          </div>
        )}
        {recovery && (
          <div className="remote-step">
            <p className="body-copy">Save these recovery codes somewhere safe. Each works once if you lose your device. They are not shown again.</p>
            <pre className="recovery-codes">{recovery.join("\n")}</pre>
            <Button variant="primary" onClick={() => attempt(check)}>
              I saved them
            </Button>
          </div>
        )}
        {step === "unlock" && (
          <form className="remote-step" onSubmit={event => unlock(event, true)}>
            <p className="body-copy">
              Signed in as <strong>{me.user.name}</strong>. With a passphrase, this device keeps an encrypted copy so you can keep working without a
              connection for up to a day. Without one, pending changes last only while this tab is open.
            </p>
            <Field label="Offline passphrase" help="Use the same passphrase each time on this device.">
              <input type="password" autoComplete="new-password" minLength={8} value={form.passphrase} onChange={field("passphrase")} />
            </Field>
            <div className="row">
              <Button type="submit" variant="primary" icon={Lock} disabled={busy || form.passphrase.length < 8}>
                Unlock offline copy
              </Button>
              <Button type="button" disabled={busy} onClick={() => unlock(null, false)}>
                Continue without one
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {onLeave && step !== "checking" && (
          <button type="button" className="text-button muted" onClick={onLeave}>
            Use the sample workspace instead
          </button>
        )}
      </Card>
    </div>
  );
}
