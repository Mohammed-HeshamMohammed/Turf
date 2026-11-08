import { useEffect, useRef, useState } from "react";
import { Lock, ShieldCheck, SignIn, UserCircleMinus, WifiSlash } from "@phosphor-icons/react";
import { AppleMark, GoogleMark } from "./SignInMarks.jsx";
import { api, apiBase, auth, organization, SERVER, SITE, setApiBase, setOrganization } from "./remote/api.ts";
import { MemoryVault, Vault } from "./remote/vault.ts";
import { inDesktopApp } from "./popout.ts";
import { Button, Card, DatePicker, Field } from "./ui.jsx";
import { SecondStep } from "./SecondStep.jsx";
import { PasswordStrength, PasswordTips } from "./DevicePasswordHelp.jsx";
import { PasswordInput } from "./PasswordInput.jsx";
import { assess, MAX_LENGTH } from "./remote/password-check.ts";
import { HumanCheck, humanToken } from "./remote/human-check.jsx";

/**
 * Signs in with the auth service, opens the person's workspace on Caller Whale's server, and unlocks this device's offline
 * copy, then hands the session to the app.
 * Steps: email and password (or Google) → a two-step code when auth asks → the workspace (only for the owner, admins and
 * the people they invited; anyone else is told they are not invited) → a two-step code when the role needs one → the
 * offline passphrase.
 */
/**
 * One Caller Whale account for the website and the CRM. The CRM in a browser keeps its own session (it is a different address),
 * so a visit with none goes to the website's sign-in once: signed in there already, it comes straight back with a one-time
 * code and the person is in; otherwise they sign in there and come back. Only once per tab, so signing out here stays out.
 */
function goToWebsiteSignIn(automatic) {
  try {
    if (automatic) {
      if (window.sessionStorage.getItem("cw-sso") === "tried") return false;
      window.sessionStorage.setItem("cw-sso", "tried");
    }
  } catch {
    if (automatic) return false; // no storage to remember it, so never risk a loop
  }
  window.location.replace(`${SITE}/signin?next=app`);
  return true;
}

// The human check asks the same auth client for its settings.
const getAuth = async () => auth;

// What the person chose on this device the first time: "online" means they skipped the offline copy, and are not asked again.
const choiceKey = owner => "cw-device-choice:" + owner;
const readChoice = owner => {
  try {
    return window.localStorage.getItem(choiceKey(owner));
  } catch {
    return null;
  }
};
const writeChoice = (owner, value) => {
  try {
    if (value) window.localStorage.setItem(choiceKey(owner), value);
    else window.localStorage.removeItem(choiceKey(owner));
  } catch {
    /* without storage they are simply asked again */
  }
};

export function RemoteGate({ onReady, onLeave }) {
  const [step, setStep] = useState("checking");
  // A Google sign-in that did not work comes back with its reason in the address.
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get("oauth_error") || "");
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState(null);
  const [birthDate, setBirthDate] = useState("");
  const [enrolment, setEnrolment] = useState(null);
  const [recovery, setRecovery] = useState(null);
  // The second step: the challenge the server handed over, and the ways it may be answered.
  const [second, setSecond] = useState(null);
  const [form, setForm] = useState({ email: "", password: "", code: "", passphrase: "" });
  // This device already holds an offline copy for this person: it only needs its password, not a new one.
  const [hasCopy, setHasCopy] = useState(false);
  const field = name => event => setForm({ ...form, [name]: event.target.value });
  const kind = inDesktopApp() ? "desktop" : "browser";

  async function check() {
    try {
      if (!auth.signedIn()) {
        if (!inDesktopApp() && goToWebsiteSignIn(true)) return setStep("checking");
        return setStep("signin");
      }
      // Caller Whale is for adults: an account that has not given its date of birth gives it before anything else.
      const sessionPerson = await auth.me({ fresh: true }).catch(() => null);
      if (sessionPerson && !sessionPerson.setup_exempt && sessionPerson.age_confirmed === false) {
        setMe({ user: sessionPerson });
        return setStep("age");
      }
      // The terms and what their work is are agreed and answered on the website, in the same few steps.
      if (sessionPerson && !sessionPerson.setup_exempt && (sessionPerson.terms_accepted === false || sessionPerson.work_profile === null)) {
        setMe({ user: sessionPerson });
        return setStep("setup");
      }
      // An invitation from Caller Whale opens the person's workspace the first time they arrive with its email confirmed.
      const account = await api.account();
      if (account.access?.status === "unverified") {
        setMe({ user: account.person });
        return setStep("verify");
      }
      let identity = await api.me();
      const organizations = identity.organizations || [];
      // Access to the workspace this device last used was removed or has ended: its offline copy goes too.
      if (organization() && !organizations.some(item => item.id === organization())) {
        await Vault.wipe();
        setOrganization("");
      }
      if (!organizations.length) {
        setMe(identity);
        // Only Caller Whale's owner and admins, and people they invited, get a workspace (the server decides): anyone else
        // is told so, and nothing else is offered.
        return setStep("notinvited");
      }
      // The organization this device used last, if the person is still in it; otherwise their first.
      const chosen = organizations.find(item => item.id === organization())?.id || organizations[0].id;
      if (identity.organization_id !== chosen) {
        setOrganization(chosen);
        identity = await api.me();
      }
      setMe(identity);
      if (identity.mfa.required && !identity.mfa.passed) {
        // Auth knows whether two-step sign-in is on; Caller Whale's server only knows whether this session passed it.
        // Ask the auth service which ways this person has (an authenticator, email, Telegram, an approval on another device).
        const offered = await auth.startStepUp().catch(() => null);
        if (offered?.methods?.length) {
          setSecond(offered);
          return setStep("second");
        }
        // Only now is /v1/me needed: to tell a person who has an authenticator from one who must set it up.
        return setStep((await auth.me()).mfa_enrolled ? "stepup" : "enroll");
      }
      // The trial or plan has run out: the server refuses CRM records until it is renewed on the website.
      if (identity.subscription && !identity.subscription.usable) return setStep("plan");
      // The choice made on this device the first time is remembered: no question on every visit.
      const owner = identity.user.id + ":" + identity.organization_id;
      if (readChoice(owner) === "online") return onReady({ me: identity, vault: new MemoryVault(), persistent: false });
      setHasCopy(await Vault.has(owner));
      setStep("unlock");
    } catch (reason) {
      if (reason?.code === "offline") return setStep("offline");
      if (reason?.status === 401) await auth.signOut();
      else if (reason?.message) setError(reason.message);
      setStep("signin");
    }
  }

  useEffect(() => {
    if (!apiBase()) setApiBase(SERVER);
    // Back from Google in this tab: finish that sign-in (it reads the address before it is cleared), then carry on.
    const back = auth.finishProvider();
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    attempt(async () => {
      try {
        await back;
      } catch (reason) {
        // An authenticator is set up: the sign-in waits for its code.
        if (reason.code === "mfa_required") throw reason;
        setStep("signin");
        throw reason;
      }
      await check();
    });
  }, []);

  /** The desktop app waits for the person's browser to hand back a code; this stops waiting. */
  const waiting = useRef(null);
  useEffect(() => () => waiting.current?.(), []);
  /**
   * Google sign-in. In a browser tab the tab itself goes to Google (through the auth service) and comes back. The
   * desktop window never leaves the app: Google opens in the person's own browser, which hands a one-time code back
   * to the app on this computer.
   */
  const continueWith = provider =>
    attempt(async () => {
      if (!inDesktopApp()) return auth.startProvider(provider, "app", await humanToken(getAuth, "signin"));
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      waiting.current?.();
      const port = await invoke("google_sign_in_listen");
      const stop = await listen("callerwhale-sign-in", ({ payload }) => {
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
      await invoke("open_in_browser", { url: await auth.providerUrl(provider, "desktop", port, await humanToken(getAuth, "signin")) });
      setStep("browser");
    });
  /**
   * Sign-in in the desktop app happens on callerwhale.com, in the person's own browser: password, second step, Google and
   * Apple, with the human check on the real website. The page sends a one-time code back to this computer only; the
   * window checks it is the sign-in it started (`state`) and trades the code for its own session.
   */
  const signInWithBrowser = () =>
    attempt(async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      waiting.current?.();
      const port = await invoke("google_sign_in_listen");
      const state = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_");
      const stop = await listen("callerwhale-sign-in", ({ payload }) => {
        stop();
        waiting.current = null;
        attempt(async () => {
          if (!payload.code) {
            setStep("signin");
            throw new Error(payload.error || "Sign-in did not finish.");
          }
          if (payload.state !== state) {
            setStep("signin");
            throw new Error("That sign-in was not started in this window. Try again.");
          }
          await auth.exchange(payload.code);
          await check();
        });
      });
      waiting.current = stop;
      await invoke("open_in_browser", { url: `${SITE}/desktop-sign-in?port=${port}&state=${state}` });
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
      if (reason.code === "mfa_required" && reason.data?.challenge) {
        setSecond({ challenge: reason.data.challenge, methods: reason.data.methods });
        setStep("second");
      } else if (reason.code === "mfa_required") setStep("stepup");
      else setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  const signIn = event => {
    event.preventDefault();
    attempt(async () => {
      if (!apiBase()) setApiBase(SERVER);
      try {
        await auth.signIn(form.email.trim(), form.password, step === "code" ? form.code.trim() : undefined, kind, await humanToken(getAuth, "signin"));
      } catch (reason) {
        // Two-step sign-in is on: the server hands over a challenge and the ways to answer it.
        if (reason.code === "mfa_required" && reason.data?.challenge) {
          setSecond({ challenge: reason.data.challenge, methods: reason.data.methods });
          return setStep("second");
        }
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
      if (result.recovery_codes?.length) setRecovery(result.recovery_codes);
      else await check();
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
      const owner = me.user.id + ":" + me.organization_id;
      const vault = withPassphrase ? await Vault.unlock(form.passphrase, owner) : new MemoryVault();
      writeChoice(owner, withPassphrase ? "" : "online");
      setForm(current => ({ ...current, passphrase: "" }));
      await onReady({ me, vault, persistent: withPassphrase });
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
    <div className={"remote-gate" + (step === "unlock" && !hasCopy ? " with-help" : "")}>
      {step === "unlock" && !hasCopy && <PasswordTips />}
      <Card
        title={step === "unlock" ? (hasCopy ? "Unlock this device" : "Work offline on this device?") : step === "notinvited" ? "You are not invited" : step === "age" ? "Confirm your age" : step === "setup" ? "Finish setting up your account" : "Sign in to your Caller Whale workspace"}
        subtitle={
          step === "unlock"
            ? hasCopy
              ? "Enter the password you chose for this computer."
              : "Lock a copy of your leads on this computer."
            : step === "notinvited"
              ? "Only the owner, admins and people they invite can use Caller Whale."
              : step === "age"
                ? "Caller Whale is for people aged 18 or older."
                : step === "setup"
                  ? "Two quick steps on the website first."
                : "Your records stay on your organization's server."
        }
      >
        {step === "checking" && <p className="muted">Checking your session…</p>}
        {step === "browser" && (
          <div className="remote-step" role="status">
            <p className="body-copy">Finish signing in in your browser. Caller Whale continues here by itself when you're done.</p>
            <Button onClick={stopWaiting}>Cancel</Button>
          </div>
        )}
        {step === "offline" && (
          <div className="remote-step">
            <p className="notice">
              <WifiSlash size={18} /> Caller Whale's server cannot be reached. Check your internet connection.
            </p>
            <div className="row">
              <Button variant="primary" onClick={() => attempt(check)}>
                Try again
              </Button>
            </div>
          </div>
        )}
        {inDesktopApp() && step === "signin" && (
          <div className="remote-step">
            <p className="body-copy">Sign in on Caller Whale's website, in your browser. Caller Whale continues here when you're done.</p>
            <Button variant="primary" icon={SignIn} disabled={busy} onClick={signInWithBrowser}>
              Sign in with your browser
            </Button>
            <p className="muted">New here? Caller Whale is by invitation. Accept yours on Caller Whale's website first, then sign in here with the same account.</p>
          </div>
        )}
        {!inDesktopApp() && (step === "signin" || step === "code") && (
          <form className="remote-step" onSubmit={signIn}>
            {step === "signin" && (
              <>
                <div className="provider-buttons">
                  <Button variant="primary" disabled={busy} onClick={() => goToWebsiteSignIn(false)}>
                    Continue with your Caller Whale account
                  </Button>
                  <Button icon={GoogleMark} disabled={busy} onClick={() => continueWith("google", "Google")}>
                    Continue with Google
                  </Button>
                  <Button icon={AppleMark} disabled={busy} onClick={() => continueWith("apple", "Apple")}>
                    Continue with Apple
                  </Button>
                  <p className="provider-or muted" role="separator">
                    or with your email
                  </p>
                </div>
                <Field label="Email">
                  <input type="email" autoComplete="username" value={form.email} onChange={field("email")} required />
                </Field>
                <Field label="Password">
                  <PasswordInput autoComplete="current-password" value={form.password} onChange={field("password")} required />
                </Field>
              </>
            )}
            {step === "code" && (
              <>
                <p className="body-copy">{auth.startUrl ? "Enter the six-digit code from your authenticator app, or one of your recovery codes." : "Enter the six-digit code from your authenticator app."}</p>
                <Field label="Sign-in code">
                  <input inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={field("code")} required autoFocus />
                </Field>
              </>
            )}
            <HumanCheck getAuth={getAuth} />
            <Button type="submit" variant="primary" icon={SignIn} disabled={busy}>
              {busy ? "Signing in…" : step === "code" ? "Confirm" : "Sign in"}
            </Button>
            {step === "signin" && (
              <p className="muted">New here? Caller Whale is by invitation. Accept yours on Caller Whale's website first, then sign in here with the same account.</p>
            )}
          </form>
        )}
        {step === "second" && second && (
          <SecondStep
            auth={auth}
            challenge={second.challenge}
            methods={second.methods}
            onDone={() => {
              setSecond(null);
              setForm(current => ({ ...current, password: "", code: "" }));
              attempt(check);
            }}
            onBack={() => {
              setSecond(null);
              setStep("signin");
            }}
          />
        )}
        {step === "stepup" && (
          <form className="remote-step" onSubmit={stepUp}>
            <p className="body-copy">Your role needs your authenticator code too. {auth.startUrl ? "Enter the six-digit code, or one of your recovery codes." : "Enter the six-digit code from the app."}</p>
            <Field label="Sign-in code">
              <input inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={field("code")} required />
            </Field>
            <Button type="submit" variant="primary" icon={ShieldCheck} disabled={busy}>
              Confirm
            </Button>
            {signedInAs}
          </form>
        )}
        {step === "age" && (
          <form
            className="remote-step"
            onSubmit={event => {
              event.preventDefault();
              attempt(async () => {
                await auth.setBirthDate(birthDate);
                await check();
              });
            }}
          >
            <Field label="Date of birth" help="It is kept on your account and cannot be changed later.">
              <DatePicker
                aria-label="Date of birth"
                required
                min="1900-01-01"
                max={new Date(Date.now() - 18 * 365.2425 * 86400000).toISOString().slice(0, 10)}
                initialView="years"
                value={birthDate}
                onChange={event => setBirthDate(event.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" icon={ShieldCheck} disabled={busy || !birthDate}>
              Continue
            </Button>
            {signedInAs}
          </form>
        )}
        {step === "setup" && (
          <div className="remote-step">
            <p className="body-copy">Accept the terms and tell us about your work on the Caller Whale website, then come back and check again.</p>
            <div className="row">
              <a className="button primary" href={`${SITE}/dashboard`} target="_blank" rel="noopener noreferrer">Open the website</a>
              <Button disabled={busy} onClick={() => attempt(async () => { await check(); })}>I finished, check again</Button>
            </div>
            {signedInAs}
          </div>
        )}
        {step === "verify" && (
          <div className="remote-step">
            <p className="body-copy">
              You have an invitation. Confirm your email address first: open the link we sent to <strong>{me?.user?.email}</strong>, then check again.
            </p>
            <div className="row">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  attempt(async () => {
                    await auth.refresh().catch(() => null);
                    await check();
                  })
                }
              >
                I confirmed it, check again
              </Button>
            </div>
            {signedInAs}
          </div>
        )}
        {step === "notinvited" && (
          <div className="remote-step" role="alert">
            <p className="body-copy">
              <UserCircleMinus size={18} /> <strong>{me?.user?.email}</strong> has not been invited. Ask your admin to invite this email address, then
              sign in again. If you were invited with another address, sign in with that one.
            </p>
            <div className="row">
              <Button variant="primary" disabled={busy} onClick={() => attempt(check)}>
                Check again
              </Button>
              <Button disabled={busy} onClick={switchAccount}>
                Use another account
              </Button>
            </div>
          </div>
        )}
        {step === "enroll" && !recovery && (
          <div className="remote-step">
            <p className="body-copy">Your role needs a second sign-in step. Add Caller Whale to an authenticator app, then enter the code it shows.</p>
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
              Signed in as <strong>{me.user.name}</strong>.
            </p>
            {!hasCopy && (
              <ul className="offline-points">
                <li>
                  <strong>Your workspace is safe on our server.</strong> Already have one from another device? It is here too, nothing to move.
                </li>
                <li>
                  <strong>This password only locks a copy on this computer,</strong> so you can keep working without internet for up to a day.
                </li>
                <li>
                  <strong>Make up a new one.</strong> It is not your Caller Whale password.
                </li>
                <li>
                  <strong>Skip it</strong> and you work online only. We will not ask again on this computer.
                </li>
              </ul>
            )}
            <Field
              label="Password for this device"
              help={hasCopy ? "The one you made up for this computer, not your Caller Whale password." : "Use the same one each time on this computer. Forgot it? Your leads stay safe on our server."}
            >
              <PasswordInput autoComplete={hasCopy ? "current-password" : "new-password"} maxLength={MAX_LENGTH} value={form.passphrase} onChange={field("passphrase")} />
            </Field>
            <div className="row">
              <Button type="submit" variant="primary" icon={Lock} disabled={busy || (hasCopy ? !form.passphrase : !assess(form.passphrase).ok)}>
                {hasCopy ? "Unlock" : "Use this password"}
              </Button>
              <Button type="button" disabled={busy} onClick={() => unlock(null, false)}>
                Skip, work online only
              </Button>
            </div>
            {hasCopy && (
              <p className="muted">
                Forgot it?{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    attempt(async () => {
                      await Vault.wipe();
                      setHasCopy(false);
                    })
                  }
                >
                  Remove the copy on this computer
                </button>{" "}
                and start again. Your leads stay on our server.
              </p>
            )}
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
      {step === "unlock" && !hasCopy && <PasswordStrength value={form.passphrase} />}
    </div>
  );
}
