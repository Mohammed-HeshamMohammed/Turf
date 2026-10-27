import { useEffect, useRef, useState } from "react";
import { Buildings, GoogleLogo, Lock, ShieldCheck, SignIn, WifiSlash } from "@phosphor-icons/react";
import { api, apiBase, auth, invitationToken, organization, SERVER, setApiBase, setOrganization } from "./remote/api.js";
import { MemoryVault, Vault } from "./remote/vault.js";
import { inDesktopApp } from "./popout.js";
import { Button, Card, Field } from "./ui.jsx";

/**
 * Signs in with the auth service, opens the person's workspace on Turf's server, and unlocks this device's offline
 * copy, then hands the session to the app.
 * Steps: email and password (or Google) → a two-step code when auth asks → the workspace (a new trial, or an
 * invitation) → a two-step code when the role needs one → the offline passphrase.
 */
export function RemoteGate({ onReady, onLeave }) {
  const [step, setStep] = useState("checking");
  // A Google sign-in that did not work comes back with its reason in the address.
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get("oauth_error") || "");
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState(null);
  const [enrolment, setEnrolment] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [form, setForm] = useState({ email: "", password: "", code: "", passphrase: "", workspace: "", invitation: "" });
  const field = name => event => setForm({ ...form, [name]: event.target.value });
  const kind = inDesktopApp() ? "desktop" : "browser";

  async function check() {
    try {
      if (!auth.signedIn()) return setStep("signin");
      let identity = await api.me();
      const organizations = identity.organizations || [];
      if (!organizations.length) {
        setMe(identity);
        return setStep("workspace");
      }
      // The organization this device used last, if the person is still in it; otherwise their first.
      const chosen = organizations.find(item => item.id === organization())?.id || organizations[0].id;
      if (identity.organization_id !== chosen) {
        setOrganization(chosen);
        identity = await api.me();
      }
      setMe(identity);
      if (identity.mfa.required && !identity.mfa.passed) {
        // Auth knows whether two-step sign-in is on; Turf's server only knows whether this session passed it.
        const person = await auth.me();
        return setStep(person.mfa_enrolled ? "stepup" : "enroll");
      }
      // The trial or plan has run out: the server refuses CRM records until it is renewed on the website.
      if (identity.subscription && !identity.subscription.usable) setStep("plan");
      else setStep("unlock");
    } catch (reason) {
      if (reason?.code === "offline") return setStep("offline");
      if (reason?.status === 401) await auth.signOut();
      else if (reason?.message) setError(reason.message);
      setStep("signin");
    }
  }

  useEffect(() => {
    if (!apiBase()) setApiBase(SERVER);
    const params = new URLSearchParams(window.location.search);
    const code = params.get("turf_code");
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    // Back from Google in this tab: trade the one-time code for tokens.
    if (code) attempt(async () => {
      await auth.exchange(code);
      await check();
    });
    else check();
  }, []);

  /** The desktop app waits for the person's browser to hand back a code; this stops waiting. */
  const waiting = useRef(null);
  useEffect(() => () => waiting.current?.(), []);
  /**
   * Google sign-in. In a browser tab the tab itself goes to Google (through the auth service) and comes back. The
   * desktop window never leaves the app: Google opens in the person's own browser, which hands a one-time code back
   * to the app on this computer.
   */
  const continueWith = (provider, label) =>
    attempt(async () => {
      const available = await auth.providers().catch(() => ({}));
      if (!available[provider]) throw new Error(`${label} sign-in isn't connected yet. Use your email for now.`);
      if (!inDesktopApp()) {
        window.location.href = auth.startUrl(provider, "app");
        return;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      waiting.current?.();
      const port = await invoke("google_sign_in_listen");
      const stop = await listen("turf-sign-in", ({ payload }) => {
        stop();
        waiting.current = null;
        attempt(async () => {
          if (!payload.code) {
            setStep("signin");
            throw new Error(payload.error || "Sign-in did not finish.");
          }
          await auth.exchange(payload.code);
          await check();
        });
      });
      waiting.current = stop;
      await invoke("open_in_browser", { url: auth.startUrl(provider, "desktop", port) });
      setStep("browser");
    });
  const stopWaiting = () => {
    waiting.current?.();
    waiting.current = null;
    setStep("signin");
  };

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
      if (!apiBase()) setApiBase(SERVER);
      try {
        await auth.signIn(form.email.trim(), form.password, step === "code" ? form.code.trim() : undefined, kind);
      } catch (reason) {
        // Two-step sign-in is on: ask for the code, keeping the password only until it is sent.
        if (reason.code === "mfa_required") return setStep("code");
        throw reason;
      }
      setForm(current => ({ ...current, password: "", code: "" }));
      await check();
    });
  };
  const stepUp = event => {
    event.preventDefault();
    attempt(async () => {
      await auth.verifyMfa(form.code.trim());
      setForm(current => ({ ...current, code: "" }));
      await check();
    });
  };
  const startEnrolment = () => attempt(async () => setEnrolment(await auth.setupMfa()));
  const confirmEnrolment = event => {
    event.preventDefault();
    attempt(async () => {
      const result = await auth.confirmMfa(form.code.trim());
      setRecovery(result.recovery_codes);
    });
  };
  const startTrial = event => {
    event.preventDefault();
    attempt(async () => {
      const opened = await api.startTrial(form.workspace.trim(), Intl.DateTimeFormat().resolvedOptions().timeZone);
      setOrganization(opened.organization_id);
      await check();
    });
  };
  const join = event => {
    event.preventDefault();
    attempt(async () => {
      const joined = await api.joinInvitation(invitationToken(form.invitation));
      setOrganization(joined.organization_id);
      setForm(current => ({ ...current, invitation: "" }));
      await check();
    });
  };
  const switchAccount = () =>
    attempt(async () => {
      await auth.signOut();
      setOrganization("");
      setMe(null);
      setStep("signin");
    });
  const unlock = (event, withPassphrase) => {
    event?.preventDefault();
    attempt(async () => {
      const vault = withPassphrase ? await Vault.unlock(form.passphrase, me.user.id + ":" + me.organization_id) : new MemoryVault();
      setForm(current => ({ ...current, passphrase: "" }));
      onReady({ me, vault, persistent: withPassphrase });
    });
  };

  const signedInAs = me?.user && (
    <p className="muted">
      Signed in as {me.user.email}.{" "}
      <button type="button" className="text-button" onClick={switchAccount}>
        Use another account
      </button>
    </p>
  );

  return (
    <div className="remote-gate">
      <Card
        title={step === "unlock" ? "Keep an offline copy on this device?" : step === "workspace" ? "Open your workspace" : "Sign in to your Turf workspace"}
        subtitle={
          step === "unlock"
            ? "Records and pending changes are encrypted with a passphrase only you know."
            : step === "workspace"
              ? "Start a free trial, or join the team that invited you."
              : "Your records stay on your organization's server."
        }
      >
        {step === "checking" && <p className="muted">Checking your session…</p>}
        {step === "browser" && (
          <div className="remote-step" role="status">
            <p className="body-copy">Finish signing in with Google in your browser. Turf continues here by itself when you're done.</p>
            <Button onClick={stopWaiting}>Cancel</Button>
          </div>
        )}
        {step === "offline" && (
          <div className="remote-step">
            <p className="notice">
              <WifiSlash size={18} /> Turf's server cannot be reached. Check your internet connection.
            </p>
            <div className="row">
              <Button variant="primary" onClick={() => attempt(check)}>
                Try again
              </Button>
            </div>
          </div>
        )}
        {(step === "signin" || step === "code") && (
          <form className="remote-step" onSubmit={signIn}>
            {step === "signin" && (
              <>
                <div className="provider-buttons">
                  <Button icon={GoogleLogo} disabled={busy} onClick={() => continueWith("google", "Google")}>
                    Continue with Google
                  </Button>
                  <p className="provider-or muted" role="separator">
                    or with your email
                  </p>
                </div>
                <Field label="Email">
                  <input type="email" autoComplete="username" value={form.email} onChange={field("email")} required />
                </Field>
                <Field label="Password">
                  <input type="password" autoComplete="current-password" value={form.password} onChange={field("password")} required />
                </Field>
              </>
            )}
            {step === "code" && (
              <>
                <p className="body-copy">Enter the six-digit code from your authenticator app, or one of your recovery codes.</p>
                <Field label="Sign-in code">
                  <input inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={field("code")} required autoFocus />
                </Field>
              </>
            )}
            <Button type="submit" variant="primary" icon={SignIn} disabled={busy}>
              {busy ? "Signing in…" : step === "code" ? "Confirm" : "Sign in"}
            </Button>
            {step === "signin" && (
              <p className="muted">
                No account yet?{" "}
                <a href={(apiBase() || SERVER) + "/#/signup"} target="_blank" rel="noreferrer">
                  Start a free trial
                </a>
              </p>
            )}
          </form>
        )}
        {step === "stepup" && (
          <form className="remote-step" onSubmit={stepUp}>
            <p className="body-copy">Your role needs your authenticator code too. Enter the six-digit code, or one of your recovery codes.</p>
            <Field label="Sign-in code">
              <input inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={field("code")} required />
            </Field>
            <Button type="submit" variant="primary" icon={ShieldCheck} disabled={busy}>
              Confirm
            </Button>
            {signedInAs}
          </form>
        )}
        {step === "workspace" && (
          <div className="remote-step">
            <form onSubmit={startTrial}>
              <Field label="Workspace name" help="Optional. You can change it later.">
                <input value={form.workspace} onChange={field("workspace")} placeholder={me?.user ? `${me.user.name}'s workspace` : ""} />
              </Field>
              <Button type="submit" variant="primary" icon={Buildings} disabled={busy}>
                Start my free trial
              </Button>
            </form>
            <form onSubmit={join}>
              <Field label="Or join with an invitation" help="Paste the invitation link from your email.">
                <input value={form.invitation} onChange={field("invitation")} required />
              </Field>
              <Button type="submit" disabled={busy}>
                Join the team
              </Button>
            </form>
            {signedInAs}
          </div>
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
            <Button
              variant="primary"
              onClick={() =>
                attempt(async () => {
                  setRecovery(null);
                  await check();
                })
              }
            >
              I saved them
            </Button>
          </div>
        )}
        {step === "plan" && (
          <div className="remote-step">
            <p className="notice" role="alert">
              {me.subscription.reason}
            </p>
            <div className="row">
              <a className="button primary" href={apiBase() + "/#/account"} target="_blank" rel="noreferrer">
                <span>Open your account</span>
              </a>
              <Button onClick={() => attempt(check)}>I renewed, check again</Button>
            </div>
          </div>
        )}
        {step === "unlock" && (
          <form className="remote-step" onSubmit={event => unlock(event, true)}>
            <p className="body-copy">
              Signed in as <strong>{me.user.name}</strong>. With a passphrase, this device keeps an encrypted copy so you can keep working without a connection
              for up to a day. Without one, pending changes last only while this tab is open.
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
