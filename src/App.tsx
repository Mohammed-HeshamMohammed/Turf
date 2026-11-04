import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes } from "react";
import { createAuth, type AuthError, type Me } from "./auth/auth-client.js";
import { HumanCheck } from "./auth/human-check.jsx";
import { redirectFor } from "./guard.ts";
import { applyMetadata, metadataFor } from "./metadata.ts";
import { Link, go, useRoute } from "./nav.tsx";
import { Pricing } from "./Pricing.tsx";
import { FeaturesIndex, FeaturePage } from "./Features.tsx";
import { Security } from "./Security.tsx";
import { Contact, Privacy, Terms } from "./PublicPages.tsx";
import { WhyCallerWhale } from "./WhyCallerWhale.tsx";
import { HeroDemo } from "./components/ui/demo.tsx";
import { SiteHeader } from "./components/ui/site-header.tsx";
import { SiteFooter } from "./components/ui/site-footer.tsx";
import { cleanPath, routeFor } from "./routes.ts";

// Anything that changes who is signed in (new tokens, a refresh the server refused, signing out) tells the page.
const listeners = new Set<() => void>();
const auth = createAuth({
  base: import.meta.env.VITE_CALLERWHALE_AUTH_URL || "http://localhost:8101",
  onChange: () => listeners.forEach(listener => listener()),
});
const getAuth = async () => auth;
// Where the auth client keeps the refresh token: another tab signing in or out changes it.
const REFRESH_KEY = "callerwhale.auth.refresh";

/** Who is signed in: undefined while asking, null when nobody. */
type Who = Me | null | undefined;

function useMe() {
  // Match the prerendered HTML on the first browser render so it can hydrate.
  const [me, setMe] = useState<Who>(null);
  useEffect(() => {
    let live = true;
    const ask = () => {
      if (!auth.signedIn()) return setMe(null);
      auth.me().then(
        m => live && setMe(m),
        () => live && setMe(null),
      );
    };
    // Coming back from Google signs this page in before anything else is asked.
    if (auth.signedIn()) setMe(undefined);
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
  }, []);
  return [me, setMe] as const;
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
  const [state, setState] = useState({ busy: false, error: "", info: "" });
  const run = async (fn: () => Promise<string | void>) => {
    setState({ busy: true, error: "", info: "" });
    try {
      const info = await fn();
      setState({ busy: false, error: "", info: info || "" });
      return true;
    } catch (error) {
      setState({ busy: false, error: (error as Error).message || "Something went wrong. Try again.", info: "" });
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

function SignIn({ onDone, notice }: { onDone: () => void; notice: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [human, setHuman] = useState("");
  const [state, run] = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => {
      try {
        await auth.signIn(email, password, code || undefined, "browser", human);
      } catch (error) {
        if ((error as AuthError).code === "mfa_required") {
          setNeedCode(true);
          throw new Error("Enter the code from your authenticator app.");
        }
        throw error;
      }
    });
    if (ok) onDone();
  };
  return (
    <div className="form-wrap">
      <form className="form card" onSubmit={submit}>
        <h1>Sign in</h1>
        {notice && <p className="notice" role="status">{notice}</p>}
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} />
        {needCode && <Field label="Code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e: ChangeEvent<HTMLInputElement>) => setCode(e.target.value)} />}
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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [human, setHuman] = useState("");
  const [state, run] = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(async () => void (await auth.signUp(name, email, password, "browser", human)))) onDone();
  };
  return (
    <div className="form-wrap">
      <form className="form card" onSubmit={submit}>
        <h1>Create your account</h1>
        <Field label="Name" autoComplete="name" required value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} />
        <HumanCheck getAuth={getAuth} action="signup" onToken={setHuman} />
        {state.error && <p className="notice bad" role="alert">{state.error}</p>}
        <button className="button primary" disabled={state.busy}>{state.busy ? "Creating…" : "Sign up"}</button>
        <Providers action="signup" human={human} />
        <div className="alt">
          <span className="muted">Already have an account?</span>
          <Link to="/signin">Sign in</Link>
        </div>
      </form>
    </div>
  );
}

function Forgot() {
  const [email, setEmail] = useState("");
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

function Account({ me }: { me: Who }) {
  if (me === undefined) return <div className="form-wrap"><p className="muted">Loading…</p></div>;
  if (!me) {
    return (
      <div className="form-wrap">
        <div className="form card">
          <h1>You are signed out</h1>
          <Link className="button primary" to="/signin">Sign in</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="form-wrap">
      <div className="form card">
        <h1>Your account</h1>
        <p style={{ margin: 0 }}>
          <b>{me.name || me.email}</b>
          <br />
          <span className="muted">{me.email}</span>
        </p>
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
  const [me, setMe] = useMe();
  const [notice, setNotice] = useState("");
  const leaving = useRef(false); // true while the person themselves is signing out
  const wasIn = useRef(false);
  const signedIn = () => {
    setNotice("");
    setMe(undefined);
    auth.me({ fresh: true }).then(setMe, () => setMe(null));
    go("/account");
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
  useEffect(() => {
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
  const pages: Record<string, React.ReactNode> = {
    "/": <Home me={me} />,
    "/signin": <SignIn onDone={signedIn} notice={notice} />,
    "/signup": <SignUp onDone={signedIn} />,
    "/forgot": <Forgot />,
    "/pricing": <Pricing />,
    "/features": <FeaturesIndex />,
    "/why-caller-whale": <WhyCallerWhale />,
    "/security": <Security />,
    "/contact": <Contact getAuth={getAuth} />,
    "/privacy": <Privacy />,
    "/terms": <Terms />,
    "/account": <Account me={me} />,
  };
  const featureSlug = cleanPath(path).startsWith("/features/") ? cleanPath(path).slice("/features/".length) : "";
  return (
    <div className={`page${cleanPath(path) === "/" ? " home-page" : ""}`}>
      <SiteHeader path={path} me={me} onSignOut={signOut} />
      <main>{pages[cleanPath(path)] || (routeFor(path).key.startsWith("feature:") ? <FeaturePage slug={featureSlug} /> : <NotFound />)}</main>
      <SiteFooter />
    </div>
  );
}
