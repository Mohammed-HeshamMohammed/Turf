import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes } from "react";
import { createAuth, type AuthError, type Me } from "./auth/auth-client.js";
import { HumanCheck, HumanNotice, humanToken } from "./auth/human-check.jsx";
import { redirectFor, waitingForSecondStep } from "./guard.ts";
import { readProfile, writeProfile, type CachedProfile } from "./profile-cache.ts";
import { applyMetadata, metadataFor } from "./metadata.ts";
import { Link, go, useRoute } from "./nav.tsx";
import { Pricing } from "./Pricing.tsx";
import { FeaturesIndex, FeaturePage } from "./Features.tsx";
import { Security } from "./Security.tsx";
import { AcceptableUse, Contact, DataProcessing, Privacy, RemoveMyInformation, Terms } from "./PublicPages.tsx";
import { NotMe, OutageBanner, StatusPage } from "./Status.tsx";
import { WhyCallerWhale } from "./WhyCallerWhale.tsx";
import { Home } from "./Home.tsx";
import { AnnouncementBanner } from "./Announcement.tsx";
import { SiteHeader } from "./components/ui/site-header.tsx";
import { hasCrmAccess, type CrmAccess } from "./crm-access.ts";
import { crmUrl } from "./crm-url.ts";
import { paramOf, wantsCrm } from "./links.ts";
import { ageProblem } from "./age.ts";
import { BirthDateField } from "./BirthDate.tsx";
import { AvatarCropper } from "./AvatarCropper.tsx";
import { splitName } from "./person-name.ts";
import { SiteFooter } from "./components/ui/site-footer.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { Settings } from "./Settings.tsx";
import { Profile } from "./Profile.tsx";
import { profilePath, usernameInPath } from "./profile-path.ts";
import { Connect } from "./Connect.tsx";
import { Setup } from "./Setup.tsx";
import { Assistant } from "./Assistant.tsx";
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

function Providers({ action, shared = false }: { action: string; shared?: boolean }) {
  const [list, setList] = useState<{ google?: boolean; apple?: boolean; microsoft?: boolean }>({});
  const [state, run] = useAction();
  useEffect(() => {
    auth.providers().then(setList, () => {});
  }, []);
  // Hidden only when the server says Google is off. When the question cannot be answered (a blocker, a privacy setting, a
  // network that stops auth.callerwhale.com), the button stays, and pressing it says what is wrong instead of vanishing.
  if (list.google === false) return null;
  return (
    <>
      <button type="button" className="button raised" disabled={state.busy} onClick={() => run(async () => { auth.chooseDevice(shared); await auth.startProvider("google", "landing", await humanToken(getAuth, action), action); })}>
        Continue with Google
      </button>
      {list.microsoft && <button type="button" className="button raised" disabled={state.busy} onClick={() => run(async () => { auth.chooseDevice(shared); await auth.startProvider("microsoft", "landing", await humanToken(getAuth, action), action); })}>
        Continue with Microsoft
      </button>}
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
  // "This is my device" keeps the sign-in for 30 days; "Shared device" ends it when the tab closes, and after 12 hours (D38, D188).
  const [shared, setShared] = useState(false);
  const resumed = Boolean(me && waitingForSecondStep(me)); // signed in already (Google, or an older session), second step not done
  const [state, run] = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let next: Challenge | null = null;
    const ok = await run(async () => {
      try {
        await auth.signIn(email, password, undefined, shared ? "shared" : "browser", await humanToken(getAuth, "signin"));
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
        <fieldset className="device-choice">
          <legend className="sr-only">Which device is this?</legend>
          <label className="check"><input type="radio" name="device" checked={!shared} onChange={() => setShared(false)} /> <span>This is my device: keep me signed in</span></label>
          <label className="check"><input type="radio" name="device" checked={shared} onChange={() => setShared(true)} /> <span>Shared device: sign me out when I close this tab</span></label>
        </fieldset>
        <HumanCheck getAuth={getAuth} />
        {state.error && <p className="notice bad" role="alert">{state.error}</p>}
        <button className="button primary" disabled={state.busy}>{state.busy ? "Signing in…" : "Sign in"}</button>
        <Providers action="signin" shared={shared} />
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
  // Opened from an invitation email (/signup?invitation=<id>&key=<key>): the address is the invited one, filled in and locked, and
  // confirmed by the link itself (D47, D368).
  const [invited, setInvited] = useState<{ id: string; key: string; email: string; org: string; owner: string; exists: boolean } | null>(null);
  const [inviteProblem, setInviteProblem] = useState("");
  useEffect(() => {
    const search = typeof window === "undefined" ? "" : window.location.search;
    const id = paramOf(search, "invitation"), key = paramOf(search, "key");
    if (!id || !key) return;
    fetch(`${authBase}/v1/invitations/${encodeURIComponent(id)}/preview?key=${encodeURIComponent(key)}`)
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) { setInviteProblem(body.error || "This invitation link cannot be used."); return; }
        setInvited({ id, key, email: body.email, org: body.org_name, owner: body.owner_name, exists: Boolean(body.account_exists) });
        setEmail(body.email);
        // After the account is made, the invitation opens to be accepted.
        try { window.sessionStorage.setItem("cw-after-signin", `/dashboard?invitation=${encodeURIComponent(id)}`); } catch { /* the dashboard lists it anyway */ }
      })
      .catch(() => setInviteProblem("Cannot check this invitation right now. Try again in a moment."));
  }, []);
  const [agreed, setAgreed] = useState(false);
  const [birth, setBirth] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [picture, setPicture] = useState("");
  const [choosing, setChoosing] = useState<File | null>(null);
  const [protectedByGoogle, setProtectedByGoogle] = useState(false);
  const [state, run] = useAction();
  const filePicker = useRef<HTMLInputElement>(null);
  const mismatch = again !== "" && again !== password;
  const started = Boolean(name || email || password || again);
  const birthProblem = ageProblem(birth);
  // The server says an email is taken only when the account is made, on the last step: the person is brought back to the email
  // field with the answer beside it, and it clears when they type another address.
  const [usedEmail, setUsedEmail] = useState("");
  const taken = usedEmail !== "" && usedEmail === email.trim().toLowerCase();
  const mine = encodeURIComponent(email.trim());
  useEffect(() => {
    if (state.code !== "conflict") return;
    setUsedEmail(email.trim().toLowerCase());
    setStep(1);
  }, [state.code]);

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
      await auth.signUp(name.trim(), email, password, "browser", await humanToken(getAuth, "signup"), birth, TERMS_VERSION, invited ? { id: invited.id, key: invited.key } : null);
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
          {invited && <p className="notice" role="status">{invited.owner ? `${invited.owner} invited you to ${invited.org || "their agency"}.` : `You are invited to ${invited.org || "an agency"}.`} Create your account with the invited address; you can accept the invitation right after.</p>}
          {invited?.exists && <div className="notice" role="alert"><strong>This address already has an account.</strong><p>Sign in to accept the invitation.</p><div className="notice-actions"><Link className="button primary" to={`/signin?email=${encodeURIComponent(invited.email)}`}>Sign in</Link></div></div>}
          {inviteProblem && <p className="notice bad" role="alert">{inviteProblem}</p>}
          <Field label="Display name" autoComplete="nickname" required value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
          <Field label="Email" type="email" autoComplete="email" required readOnly={Boolean(invited)} aria-readonly={invited ? true : undefined} aria-invalid={taken || undefined} aria-describedby={taken ? "email-used" : undefined} value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => { if (!invited) setEmail(e.target.value); }} />
          {taken && (
            <div className="notice" id="email-used" role="alert">
              <strong>This email already has an account.</strong>
              <p>Sign in instead, or reset your password if you forgot it. If you signed up with Google or Apple, use that button on the sign-in page.</p>
              <div className="notice-actions"><Link className="button primary" to={`/signin?email=${mine}`}>Sign in</Link><Link className="button" to={`/forgot?email=${mine}`}>Reset my password</Link></div>
            </div>
          )}
          <Field label="Password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} />
          <Field label="Confirm password" type="password" autoComplete="new-password" minLength={8} required value={again} onChange={(e: ChangeEvent<HTMLInputElement>) => setAgain(e.target.value)} />
          {mismatch && <p className="notice bad" role="alert">The two passwords are not the same.</p>}
          <label className="check"><input type="checkbox" required checked={agreed} onChange={(e: ChangeEvent<HTMLInputElement>) => setAgreed(e.target.checked)} /> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
          <button className="button primary" disabled={mismatch || !agreed || taken}>{started ? "Continue" : "Sign up"}</button>
          {/* Only Google is sent from this step (Sign up goes on to the second step, which has its own check), so the check sits just above it. */}
          <HumanCheck getAuth={getAuth} />
          <Providers action="signup" />
          <div className="alt">
            <span className="muted">Already have an account?</span>
            <Link to="/signin">Sign in</Link>
          </div>
        </form>
      ) : (
        <form className="form card" onSubmit={create}>
          <h1>Verify your age</h1>
          <p className="muted">Caller Whale is for people aged 18 or older. Your date of birth is kept on your account and cannot be changed later.</p>
          <BirthDateField value={birth} onChange={setBirth} />
          {birthProblem && <p className="notice bad" role="alert">{birthProblem}</p>}
          <div className="two-fields">
            <Field label="First name" autoComplete="given-name" required maxLength={60} value={first} onChange={(e: ChangeEvent<HTMLInputElement>) => setFirst(e.target.value)} />
            <Field label="Last name" autoComplete="family-name" maxLength={60} value={last} onChange={(e: ChangeEvent<HTMLInputElement>) => setLast(e.target.value)} />
          </div>
          <Field label="Phone number" type="tel" autoComplete="tel" placeholder="Optional" value={phone} onChange={(e: ChangeEvent<HTMLInputElement>) => setPhone(e.target.value)} />
          {choosing && <AvatarCropper file={choosing} confirmLabel="Use this picture" onCancel={() => setChoosing(null)} onDone={async dataUrl => { setPicture(dataUrl); setChoosing(null); }} />}
          <HumanCheck getAuth={getAuth} notice={false} onEnabled={setProtectedByGoogle} />
          {state.error && !taken && <p className="notice bad" role="alert">{state.error}</p>}
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
      await auth.forgotPassword(email, await humanToken(getAuth, "forgot"));
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
        <HumanCheck getAuth={getAuth} />
        <button className="button primary" disabled={state.busy}>Send the link</button>
        <div className="alt">
          <Link to="/signin">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}

/** The link in the confirmation email lands here: the token is sent to auth once, and the person is told how it went. A confirmed
 * address shows its waiting invitations in the dashboard. */
function VerifyEmail({ me, onVerified }: { me: Me | null | undefined; onVerified: () => void }) {
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [problem, setProblem] = useState("");
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    const token = paramOf(window.location.search, "token");
    if (!token) { setState("failed"); setProblem("This link has no confirmation code. Open the link from the email again."); return; }
    auth.verifyEmail(token).then(() => { setState("done"); onVerified(); }, (error: unknown) => {
      setState("failed");
      setProblem(error instanceof Error ? error.message : "This link is not valid or has expired.");
    });
  }, [onVerified]);
  return (
    <div className="form-wrap">
      <div className="form card" role="status" aria-live="polite">
        <h1>{state === "working" ? "Confirming your email…" : state === "done" ? "Your email is confirmed" : "This link did not work"}</h1>
        {state === "done" && <p className="muted">{me ? "Invitations sent to this address are waiting in your dashboard." : "Sign in to see your dashboard and any invitations sent to this address."}</p>}
        {state === "failed" && <p className="notice bad" role="alert">{problem} If your email is already confirmed, just sign in.</p>}
        {state !== "working" && <div className="alt"><Link className="button primary" to={me ? "/dashboard" : "/signin"}>{me ? "Open your dashboard" : "Sign in"}</Link></div>}
      </div>
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
    let back = "";
    try { back = window.sessionStorage.getItem("cw-after-signin") || ""; window.sessionStorage.removeItem("cw-after-signin"); } catch { /* none */ }
    if (back.startsWith("/connect") || back.startsWith("/dashboard?invitation=")) go(back);
    else if (!wantsCrm(window.location.search)) go("/dashboard");
  };
  const signOut = async () => {
    leaving.current = true;
    await auth.signOut();
    setMe(null);
    go("/");
  };
  // The title, description and canonical address follow the page (the build writes them into each page's HTML).
  // An address that is not a page of the site may be a person's own page (callerwhale.com/their-username).
  const knownPage = routeFor(path).key !== "notfound";
  const ownPageName = !knownPage ? usernameInPath(cleanPath(path)) : "";
  useEffect(() => applyMetadata(metadataFor(ownPageName ? "profile" : routeFor(path).key)), [path, ownPageName]);
  // Pages are for the right state: signed in, nobody sees the sign-in forms; signed out, nobody sees the account page.
  const fromCrm = typeof window !== "undefined" && wantsCrm(window.location.search);
  useEffect(() => {
    if (me && fromCrm) { if (!setupStep(me)) void openCrm(); return; } // the setup steps (age, terms, work) come first
    // /account is the older address of the same page: it goes to the person's own address once it is known.
    if (me && cleanPath(path) === "/profile" && !setupStep(me) && profilePath(me) !== "/account") { go(profilePath(me), { replace: true }); return; }
    if (me === null && ownPageName) { go("/signin", { replace: true }); return; }
    // An emailed invitation link (it carries a key) opens sign-up inside the invitation; with an account, that page says sign in.
    if (me === null && path.startsWith("/dashboard")) {
      const query = new URLSearchParams(window.location.search);
      if (query.has("invitation") && query.has("key")) { go(`/signup?invitation=${encodeURIComponent(query.get("invitation") || "")}&key=${encodeURIComponent(query.get("key") || "")}`, { replace: true }); return; }
    }
    const to = redirectFor(path, me);
    // An invitation link (/dashboard?invitation=<id>) also comes back to that invitation after signing in.
    if (to && !me && (path.startsWith("/connect") || (path.startsWith("/dashboard") && new URLSearchParams(window.location.search).has("invitation")))) { try { window.sessionStorage.setItem("cw-after-signin", window.location.pathname + window.location.search); } catch { /* signing in then opens the dashboard */ } }
    if (to) go(to, { replace: true });
  }, [path, me, ownPageName]);
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
    "/": <Home me={me} authBase={authBase} />,
    "/signin": me && fromCrm ? (setupStep(me) ? setup : <div className="form-wrap"><p className="muted" role="status">Opening the CRM…</p></div>) : <SignIn onDone={signedIn} notice={notice} me={me} />,
    "/signup": <SignUp onDone={signedIn} />,
    "/forgot": <Forgot />,
    "/verify": <VerifyEmail me={me} onVerified={() => { auth.me({ fresh: true }).then(setMe, () => undefined); }} />,
    "/pricing": <Pricing />,
    "/features": <FeaturesIndex />,
    "/why-caller-whale": <WhyCallerWhale />,
    "/security": <Security />,
    "/status": <StatusPage authBase={authBase} />,
    "/account/not-me": <NotMe authBase={authBase} />,
    "/contact": <Contact getAuth={getAuth} />,
    "/remove-my-information": <RemoveMyInformation getAuth={getAuth} />,
    "/dpa": <DataProcessing />,
    "/acceptable-use": <AcceptableUse />,
    "/privacy": <Privacy />,
    "/terms": <Terms />,
    "/connect": me && setupStep(me) ? setup : me ? <Connect auth={auth} authBase={authBase} search={typeof window === "undefined" ? "" : window.location.search} /> : <AccountPending error={restoreError} onRetry={retrySession} />,
    "/account": me && setupStep(me) ? setup : me ? <Settings me={me} auth={auth} authBase={authBase} onSaved={() => { auth.me({ fresh: true }).then(setMe); }} /> : <AccountPending error={restoreError} onRetry={retrySession} />,
    "/profile": me && setupStep(me) ? setup : me ? <Profile me={me} auth={auth} authBase={authBase} onSaved={() => { auth.me({ fresh: true }).then(setMe); }} /> : <AccountPending error={restoreError} onRetry={retrySession} />,
    "/dashboard": me && setupStep(me) ? setup : me ? <Dashboard me={me} auth={auth} authBase={authBase} onSaved={() => { auth.me({ fresh: true }).then(setMe); }} /> : <AccountPending error={restoreError} onRetry={retrySession} />,
  };
  const ownPage = me === undefined || me === null ? <AccountPending error={restoreError} onRetry={retrySession} /> : setupStep(me) ? setup : String(me.username || "") === ownPageName ? pages["/profile"] : <NotFound />;
  const featureSlug = cleanPath(path).startsWith("/features/") ? cleanPath(path).slice("/features/".length) : "";
  return (
    <div className={`page${cleanPath(path) === "/" ? " home-page" : ""}${cleanPath(path) === "/dashboard" ? " dashboard-shell" : ""}`}>
      {cleanPath(path) !== "/dashboard" && <AnnouncementBanner authBase={authBase} />}
      {cleanPath(path) !== "/status" && <OutageBanner authBase={authBase} />}
      <SiteHeader path={path} me={me} onSignOut={signOut} savedSession={savedSession} cached={cached} openCrm={crmLink ? openCrm : undefined} />
      <main>{pages[cleanPath(path)] || (ownPageName ? ownPage : null) || (routeFor(path).key.startsWith("feature:") ? <FeaturePage slug={featureSlug} /> : <NotFound />)}</main>
      <SiteFooter compact={cleanPath(path) === "/dashboard"} />
      <Assistant signedIn={me === undefined ? undefined : Boolean(me)} path={cleanPath(path)} />
    </div>
  );
}
