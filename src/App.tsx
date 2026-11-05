import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes } from "react";
import { createAuth, type AuthError, type Me } from "./auth/auth-client.js";
import { HumanCheck, HumanNotice } from "./auth/human-check.jsx";
import { redirectFor, waitingForSecondStep } from "./guard.ts";
import { readProfile, writeProfile, type CachedProfile } from "./profile-cache.ts";
import { applyMetadata, metadataFor } from "./metadata.ts";
import { Link, go, useRoute } from "./nav.tsx";
import { Pricing } from "./Pricing.tsx";
import { FeaturesIndex, FeaturePage } from "./Features.tsx";
import { Security } from "./Security.tsx";
import { Contact, Privacy, Terms } from "./PublicPages.tsx";
import { WhyCallerWhale } from "./WhyCallerWhale.tsx";
import { HeroDemo } from "./components/ui/demo.tsx";
import { SiteHeader } from "./components/ui/site-header.tsx";
import { hasCrmAccess, type CrmAccess } from "./crm-access.ts";
import { crmUrl } from "./crm-url.ts";
import { paramOf, wantsCrm } from "./links.ts";
import { ageProblem, latestBirthDate } from "./age.ts";
import { AvatarCropper } from "./AvatarCropper.tsx";
import { splitName } from "./person-name.ts";
import { SiteFooter } from "./components/ui/site-footer.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { Profile } from "./Profile.tsx";
import { Setup } from "./Setup.tsx";
import { TERMS_VERSION, setupStep } from "./setup.ts";
import { cleanPath, routeFor } from "./routes.ts";

// Anything that changes who is signed in (new tokens, a refresh the server refused, signing out) tells the page.
const listeners = new Set<() => void>();
const authBase = import.meta.env.VITE_CALLERWHALE_AUTH_URL || "http://localhost:8101";
const auth = createAuth({
  base: authBase,
  onChange: () => listeners.forEach(listener => listener()),
});
const getAuth = async () => auth;
// Where the auth client keeps the refresh token: another tab signing in or out changes it.
const REFRESH_KEY = "callerwhale.auth.refresh";

/** Who is signed in: undefined while asking, null when nobody. */
type Who = Me | null | undefined;

function useMe() {
  // Keep the initial state undecided on both the server and browser. Redirecting before
  // the saved session is restored sends a signed-in visitor through /signin on refresh.
  const [me, setMe] = useState<Who>(undefined);
  const [restoreError, setRestoreError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const ask = () => {
      if (!auth.signedIn()) { setRestoreError(false); setMe(null); return; }
      setRestoreError(false);
      setMe(current => current === null ? undefined : current);
      auth.me().then(
        m => live && setMe(m),
        () => {
          if (!live) return;
          if (auth.signedIn()) setRestoreError(true);
          else setMe(null);
        },
      );
    };
    // Coming back from Google signs this page in before anything else is asked.
    auth.finishProvider().catch(() => {}).finally(ask);
    // Signed in, signed out or refused by the server, here or (through storage) in another tab: ask again.
    const changed = (event: StorageEvent) => {
      if (event.key !== REFRESH_KEY) return;
      // The other tab signed out: forget this tab's copy of the session too (no request: the refresh token is gone).
      if (!event.newValue) auth.signOut().then(ask);
      else ask();
    };
    listeners.add(ask);
    addEventListener("storage", changed);
    return () => {
      live = false;
      listeners.delete(ask);
      removeEventListener("storage", changed);
    };
  }, [attempt]);
  return [me, setMe, restoreError, () => setAttempt(n => n + 1)] as const;
}

function AccountPending({ error, onRetry }: { error: boolean; onRetry: () => void }) {
  return <div className="form-wrap"><div className="card session-card" role="status">
    <span className="eyebrow">Your account</span>
    <h1>{error ? "We could not check your session" : "Checking your session"}</h1>
    <p className="muted">{error ? "Your account is still saved on this device. Check your connection and try again." : "Restoring your account and access…"}</p>
    {error && <button className="button primary" type="button" onClick={onRetry}>Try again</button>}
  </div></div>;
}

function Home({ me }: { me: Who }) {
  const steps = [["Lists", "Import leads and keep the source intact."], ["Lead records", "Find the next step and the full history."], ["Calls", "Work the queue and record outcomes."], ["Handoffs", "Move a deal to the right teammate."], ["Reports", "See what moved forward and export your data."]];
  return (
    <>
      <HeroDemo signedIn={me === undefined ? undefined : Boolean(me)} />
      <section className="section" aria-labelledby="workspace-title"><h2 id="workspace-title">One flow, from list to closed deal.</h2><div className="steps five">{steps.map(([title, text], i) => <div className="card step" key={title}><span>0{i + 1}</span><b>{title}</b><span>{text}</span></div>)}</div><p><Link to="/why-caller-whale">Why keep it together →</Link></p></section>
      <section className="cta"><h2>Build a plan around your work.</h2><p>Choose the features your team needs and see the draft monthly total as you go.</p><Link className="button primary" to="/pricing">Explore pricing</Link></section>
    </>
  );
}

function Field({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field">
      <label>
        {label}
        <input {...input} style={{ width: "100%", marginTop: 6 }} />
      </label>
    </div>
  );
}

/** Runs `fn`, keeps what went wrong (or the note it returns) for the form to show. Resolves true when it worked. */
function useAction() {
  const [state, setState] = useState({ busy: false, error: "", info: "", code: "" });
  const run = async (fn: () => Promise<string | void>) => {
    setState({ busy: true, error: "", info: "", code: "" });
    try {
      const info = await fn();
      setState({ busy: false, error: "", info: info || "", code: "" });
      return true;
    } catch (error) {
      setState({ busy: false, error: (error as Error).message || "Something went wrong. Try again.", info: "", code: (error as { code?: string }).code || "" });
      return false;
    }
  };
  return [state, run] as const;
}

function Providers({ action, human }: { action: string; human: string }) {
  const [list, setList] = useState<{ google?: boolean; apple?: boolean }>({});
  const [state, run] = useAction();
  useEffect(() => {
    auth.providers().then(setList, () => {});
  }, []);
  if (!list.google) return null;
  return (
    <>
      <button type="button" className="button raised" disabled={state.busy} onClick={() => run(async () => void (await auth.startProvider("google", "landing", human, action)))}>
        Continue with Google
      </button>
      {state.error && <p className="notice bad" role="alert">{state.error}</p>}
    </>
  );
}

type Challenge = { challenge: string; method: string };

function SignIn({ onDone, notice, me }: { onDone: () => void; notice: string; me: Me | null | undefined }) {
  const [email, setEmail] = useState(() => paramOf(typeof window === "undefined" ? "" : window.location.search, "email"));
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const resumed = Boolean(me && waitingForSecondStep(me)); // signed in already (Google, or an older session), second step not done
  const [human, setHuman] = useState("");
  const [state, run] = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let next: Challenge | null = null;
    const ok = await run(async () => {
      try {
        await auth.signIn(email, password, undefined, "browser", human);
      } catch (error) {
        if ((error as AuthError).code !== "mfa_required") throw error;
        const data = (error as AuthError).data as { challenge?: string; methods?: string[] } | null;
        const methods = data?.methods || [];
        const method = methods.includes("totp") ? "totp" : methods.find(m => m === "email" || m === "telegram");
        if (!data?.challenge || !method) throw new Error("This account needs a second step this page cannot do yet. Use the Caller Whale app.");
        if (method !== "totp") await auth.sendCode(data.challenge, method);
        next = { challenge: data.challenge, method };
      }
    });
    // Asking for the code is not signing in: nothing opens the dashboard until the code is accepted.
    if (next) setChallenge(next);
    else if (ok) onDone();
  };
  const verifyCode = async (value: string) => {
    const ok = await run(async () => {
      if (challenge) await auth.answer(challenge.challenge, challenge.method, value);
      else await auth.verifyMfa(value);
    });
    // The session now counts as verified; the page follows that by itself when it was already signed in.
    if (ok && challenge) onDone();
    else if (!ok) setCode("");
  };
  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) void verifyCode(code.trim());
  };
  // The sixth digit sends the code by itself: no Enter, no button.
  const typeCode = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, "").slice(0, 6);
    setCode(value);
    if (value.length === 6 && !state.busy) void verifyCode(value);
  };
  if (challenge || resumed) {
    // The password was right: the card now asks for the second step and nothing else.
    return (
      <div className="form-wrap">
        <form className="form card" onSubmit={verify}>
          <h1>Confirm it's you</h1>
          <p className="fine">{challenge && challenge.method !== "totp" ? `Enter the code we sent you by ${challenge.method}.` : "Enter the 6-digit code from your authenticator app."}</p>
          <Field label="Code" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={6} placeholder="000000" value={code} onChange={typeCode} />
          {state.error && <p className="notice bad" role="alert">{state.error}</p>}
          <button className="button primary" disabled={state.busy}>{state.busy ? "Checking…" : "Verify"}</button>
          <div className="alt">
            <button type="button" className="button raised" onClick={() => { setCode(""); setPassword(""); if (challenge) setChallenge(null); else void auth.signOut(); }}>Use a different account</button>
          </div>
        </form>
      </div>
    );
  }
  return (
    <div className="form-wrap">
      <form className="form card" onSubmit={submit}>
        <h1>Sign in</h1>
        {notice && <p className="notice" role="status">{notice}</p>}
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} />
        <HumanCheck getAuth={getAuth} action="signin" onToken={setHuman} />
        {state.error && <p className="notice bad" role="alert">{state.error}</p>}
        <button className="button primary" disabled={state.busy}>{state.busy ? "Signing in…" : "Sign in"}</button>
        <Providers action="signin" human={human} />
        <div className="alt">
          <Link to="/forgot">Forgot your password?</Link>
          <Link to="/signup">Create an account</Link>
        </div>
      </form>
    </div>
  );
}

function SignUp({ onDone }: { onDone: () => void }) {
  // Two steps on one form: the account (display name, email, password, terms), then who you are (age, names, phone, picture).
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [birth, setBirth] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [picture, setPicture] = useState("");
  const [choosing, setChoosing] = useState<File | null>(null);
  const [human, setHuman] = useState("");
  const [protectedByGoogle, setProtectedByGoogle] = useState(false);
  const [state, run] = useAction();
  const filePicker = useRef<HTMLInputElement>(null);
  const mismatch = again !== "" && again !== password;
  const started = Boolean(name || email || password || again);
  const birthProblem = ageProblem(birth);
  const taken = state.code === "conflict";
  const mine = encodeURIComponent(email.trim());

  const next = (e: FormEvent) => {
    e.preventDefault();
    if (mismatch || !agreed) return;
    if (!first && !last) { const parts = splitName(name); setFirst(parts.first); setLast(parts.last); }
    setStep(2);
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (birthProblem || !birth) return;
    const made = await run(async () => {
      await auth.signUp(name.trim(), email, password, "browser", human, birth, TERMS_VERSION);
      // The account exists now. Its names, phone and picture are saved with it; if that fails, the profile page can do it later.
      try {
        const token = await auth.accessToken();
        if (token) {
          await fetch(`${authBase}/v1/me/profile`, {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim(), phone: phone.trim(), avatar: picture, first_name: first, middle_name: "", last_name: last }),
          });
        }
      } catch { /* the account is made either way */ }
    });
    if (made) onDone();
  };

  const shownName = [first, last].map(part => part.trim()).filter(Boolean).join(" ");
  return (
    <div className={`form-wrap${step === 2 ? " signup-two" : ""}`}>
      {step === 2 && (
        <aside className="signup-preview" aria-label="Your profile preview">
          <button type="button" className="profile-avatar profile-avatar-button" aria-label="Choose a profile picture" onClick={() => filePicker.current?.click()}>
            {picture ? <img src={picture} alt="" /> : (first || name || "?").trim().charAt(0).toUpperCase()}
            <span className="profile-avatar-change" aria-hidden="true">{picture ? "Change" : "Add photo"}</span>
          </button>
          <strong className="signup-preview-name">{shownName || name.trim() || "Your name"}</strong>
          <span className="muted signup-preview-email">{email.trim() || "you@example.com"}</span>
          {picture ? <button type="button" className="text-button" onClick={() => setPicture("")}>Remove picture</button> : <span className="muted signup-preview-hint">Press the picture to add one</span>}
          <input ref={filePicker} type="file" hidden accept="image/*" onChange={(e: ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) setChoosing(file); }} />
        </aside>
      )}
      {step === 1 ? (
        <form className="form card" onSubmit={next}>
          <h1>Create your account</h1>
          <Field label="Display name" autoComplete="nickname" required value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
          <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
          <Field label="Password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} />
          <Field label="Confirm password" type="password" autoComplete="new-password" minLength={8} required value={again} onChange={(e: ChangeEvent<HTMLInputElement>) => setAgain(e.target.value)} />
          {mismatch && <p className="notice bad" role="alert">The two passwords are not the same.</p>}
          <label className="check"><input type="checkbox" required checked={agreed} onChange={(e: ChangeEvent<HTMLInputElement>) => setAgreed(e.target.checked)} /> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
          <button className="button primary" disabled={mismatch || !agreed}>{started ? "Continue" : "Sign up"}</button>
          <Providers action="signup" human={human} />
          <div className="alt">
            <span className="muted">Already have an account?</span>
            <Link to="/signin">Sign in</Link>
          </div>
        </form>
      ) : (
        <form className="form card" onSubmit={create}>
          <h1>Verify your age</h1>
          <p className="muted">Caller Whale is for people aged 18 or older. Your date of birth is kept on your account and cannot be changed later.</p>
          <Field label="Date of birth" type="date" autoComplete="bday" required max={latestBirthDate()} min="1900-01-01" value={birth} onChange={(e: ChangeEvent<HTMLInputElement>) => setBirth(e.target.value)} />
          {birthProblem && <p className="notice bad" role="alert">{birthProblem}</p>}
          <div className="two-fields">
            <Field label="First name" autoComplete="given-name" required maxLength={60} value={first} onChange={(e: ChangeEvent<HTMLInputElement>) => setFirst(e.target.value)} />
            <Field label="Last name" autoComplete="family-name" maxLength={60} value={last} onChange={(e: ChangeEvent<HTMLInputElement>) => setLast(e.target.value)} />
          </div>
          <Field label="Phone number" type="tel" autoComplete="tel" placeholder="Optional" value={phone} onChange={(e: ChangeEvent<HTMLInputElement>) => setPhone(e.target.value)} />
          {choosing && <AvatarCropper file={choosing} confirmLabel="Use this picture" onCancel={() => setChoosing(null)} onDone={async dataUrl => { setPicture(dataUrl); setChoosing(null); }} />}
          <HumanCheck getAuth={getAuth} action="signup" onToken={setHuman} notice={false} onEnabled={setProtectedByGoogle} />
          {taken ? (
            <div className="notice" role="alert">
              <strong>You already have an account with this email.</strong>
              <p>Sign in instead. If you forgot your password, we can email you a link to choose a new one. If you signed up with Google or Apple, use that button on the sign-in page.</p>
              <div className="notice-actions"><Link className="button primary" to={`/signin?email=${mine}`}>Sign in</Link><Link className="button" to={`/forgot?email=${mine}`}>Reset my password</Link></div>
            </div>
          ) : state.error && <p className="notice bad" role="alert">{state.error}</p>}
          <button className="button primary" disabled={state.busy || !birth || Boolean(birthProblem) || !first.trim()}>{state.busy ? <><span className="spinner" aria-hidden="true" />Creating…</> : "Create account"}</button>
          <button type="button" className="text-button" disabled={state.busy} onClick={() => setStep(1)}>Back</button>
        </form>
      )}
      {protectedByGoogle && step === 2 && <div className="form-note"><HumanNotice /></div>}
    </div>
  );
}

function Forgot() {
  const [email, setEmail] = useState(() => paramOf(typeof window === "undefined" ? "" : window.location.search, "email"));
  const [state, run] = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await auth.forgotPassword(email);
      return "If that address has an account, a reset link is on its way.";
    });
  };
  return (
    <div className="form-wrap">
      <form className="form card" onSubmit={submit}>
        <h1>Reset your password</h1>
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
        {state.error && <p className="notice bad" role="alert">{state.error}</p>}
        {state.info && <p className="notice" role="status">{state.info}</p>}
        <button className="button primary" disabled={state.busy}>Send the link</button>
        <div className="alt">
          <Link to="/signin">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}

function NotFound() {
  return (
    <div className="form-wrap">
      <div className="form card">
        <h1>Page not found</h1>
        <p className="muted" style={{ margin: 0 }}>That page does not exist.</p>
        <Link className="button primary" to="/">Go to the home page</Link>
      </div>
    </div>
  );
}

/** The whole site for one path. The browser renders it live; the build renders it once per page into that page's HTML. */
export function App({ path: first = "/" }) {
  const path = useRoute(first);
  const [me, setMe, restoreError, retrySession] = useMe();
  const [notice, setNotice] = useState("");
  // Until the profile arrives (and in the page built ahead of time) the header shows Sign in and Sign up, unless this browser
  // holds a saved session, so the buttons never go missing for a visitor.
  const [savedSession, setSavedSession] = useState(false);
  useEffect(() => setSavedSession(auth.signedIn()), [me]);
  // The last-known profile, read once the page is in the browser (the page built ahead of time never has it), so a refresh keeps the
  // person's picture in the header while the real answer loads; it is updated on every answer and removed when nobody is signed in.
  const [cached, setCached] = useState<CachedProfile | null>(null);
  useEffect(() => setCached(readProfile()), []);
  useEffect(() => { if (me) { writeProfile(me); setCached(readProfile()); } else if (me === null) { writeProfile(null); setCached(null); } }, [me]);
  // The link to the CRM is offered only to people with access to it (staff, or members of a workspace).
  const [crmLink, setCrmLink] = useState(false);
  // Carries this sign-in to the CRM web app: a one-time code (good for two minutes) is traded there for its own session.
  const openCrm = async () => {
    try { window.location.assign(`${crmUrl}/?callerwhale_code=${encodeURIComponent(await auth.handoff("browser"))}`); }
    catch { window.location.assign(crmUrl); }
  };
  useEffect(() => {
    setCrmLink(false);
    if (!me || setupStep(me)) return;
    const controller = new AbortController();
    auth.accessToken().then(async token => {
      if (!token) return;
      const response = await fetch(`${authBase}/v1/me/access`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (response.ok && !controller.signal.aborted) setCrmLink(hasCrmAccess((await response.json()) as CrmAccess));
    }).catch(() => {});
    return () => controller.abort();
  }, [me?.id]);
  const leaving = useRef(false); // true while the person themselves is signing out
  const wasIn = useRef(false);
  const signedIn = () => {
    setNotice("");
    setMe(undefined);
    // keep() already notifies useMe, which restores the profile and handles a temporary failure.
    if (!wantsCrm(window.location.search)) go("/dashboard");
  };
  const signOut = async () => {
    leaving.current = true;
    await auth.signOut();
    setMe(null);
    go("/");
  };
  // The title, description and canonical address follow the page (the build writes them into each page's HTML).
  useEffect(() => applyMetadata(metadataFor(routeFor(path).key)), [path]);
  // Pages are for the right state: signed in, nobody sees the sign-in forms; signed out, nobody sees the account page.
  const fromCrm = typeof window !== "undefined" && wantsCrm(window.location.search);
  useEffect(() => {
    if (me && fromCrm) { if (!setupStep(me)) void openCrm(); return; } // the setup steps (age, terms, work) come first
    const to = redirectFor(path, me);
    if (to) go(to, { replace: true });
  }, [path, me]);
  // Signed in and then not, without the person asking (the session ended, or they signed out in another tab): say so.
  useEffect(() => {
    if (me) {
      wasIn.current = true;
      leaving.current = false;
    } else if (me === null && wasIn.current) {
      wasIn.current = false;
      if (!leaving.current) setNotice("Your session ended. Sign in again.");
      leaving.current = false;
    }
  }, [me]);
  // An account with a setup step still to do (its age, the terms, what its work is) does it before anything else.
  const setup = me ? <Setup me={me} auth={auth} onDone={() => { auth.me({ fresh: true }).then(setMe); }} onSignOut={signOut} /> : null;
  const pages: Record<string, React.ReactNode> = {
    "/": <Home me={me} />,
    "/signin": me && fromCrm ? (setupStep(me) ? setup : <div className="form-wrap"><p className="muted" role="status">Opening the CRM…</p></div>) : <SignIn onDone={signedIn} notice={notice} me={me} />,
    "/signup": <SignUp onDone={signedIn} />,
    "/forgot": <Forgot />,
    "/pricing": <Pricing />,
    "/features": <FeaturesIndex />,
    "/why-caller-whale": <WhyCallerWhale />,
    "/security": <Security />,
    "/contact": <Contact getAuth={getAuth} />,
    "/privacy": <Privacy />,
    "/terms": <Terms />,
    "/account": me && setupStep(me) ? setup : me ? <Profile me={me} auth={auth} authBase={authBase} onSaved={() => { auth.me({ fresh: true }).then(setMe); }} /> : <AccountPending error={restoreError} onRetry={retrySession} />,
    "/dashboard": me && setupStep(me) ? setup : me ? <Dashboard me={me} auth={auth} authBase={authBase} /> : <AccountPending error={restoreError} onRetry={retrySession} />,
  };
  const featureSlug = cleanPath(path).startsWith("/features/") ? cleanPath(path).slice("/features/".length) : "";
  return (
    <div className={`page${cleanPath(path) === "/" ? " home-page" : ""}${cleanPath(path) === "/dashboard" ? " dashboard-shell" : ""}`}>
      <SiteHeader path={path} me={me} onSignOut={signOut} savedSession={savedSession} cached={cached} openCrm={crmLink ? openCrm : undefined} />
      <main>{pages[cleanPath(path)] || (routeFor(path).key.startsWith("feature:") ? <FeaturePage slug={featureSlug} /> : <NotFound />)}</main>
      <SiteFooter compact={cleanPath(path) === "/dashboard"} />
    </div>
  );
}
