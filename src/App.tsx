import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes } from "react";
import { createAuth, type AuthError, type Me } from "./auth/auth-client.js";
import { HumanCheck } from "./auth/human-check.jsx";
import { redirectFor } from "./guard.ts";
import { applyMetadata, metadataFor } from "./metadata.ts";
import { Link, go, useRoute } from "./nav.tsx";
import { Pricing } from "./Pricing.tsx";
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
  const [me, setMe] = useState<Who>(auth.signedIn() ? undefined : null);
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

function Header({ path, me, onSignOut }: { path: string; me: Who; onSignOut: () => void }) {
  const current = (to: string) => (path === to ? "page" : undefined);
  return (
    <header className="header">
      <Link to="/" className="brand">
        <img src="/favicon.svg" alt="" />
        Caller Whale
      </Link>
      <nav className="rail" aria-label="Main">
        <Link to="/pricing" aria-current={current("/pricing")}>Pricing</Link>
      </nav>
      <nav className="rail" aria-label="Account" aria-busy={me === undefined}>
        {me === undefined ? null : me ? (
          <>
            <Link to="/account" aria-current={current("/account")}>Account</Link>
            <a
              href="/"
              onClick={e => {
                e.preventDefault();
                onSignOut();
              }}
            >
              Sign out
            </a>
          </>
        ) : (
          <>
            <Link to="/signin" aria-current={current("/signin")}>Sign in</Link>
            <Link to="/signup" aria-current={current("/signup")}>Sign up</Link>
          </>
        )}
      </nav>
    </header>
  );
}

function Home({ me }: { me: Who }) {
  const steps = [
    ["Sign up", "Make your account with an email and password, or with Google."],
    ["Open the workspace", "Your leads, calls and team in one place."],
    ["Call", "Work the list and keep every conversation on record."],
  ];
  return (
    <>
      <section className="hero">
        <div className="card">
          <span className="badge">Calling workspace</span>
          <h1>Work every lead by phone, in one place.</h1>
          <p>Caller Whale keeps your leads, your calls and your team together, so the next call is always one click away.</p>
          <div className="actions">
            {me === undefined ? null : me ? (
              <Link className="button primary" to="/account">Your account</Link>
            ) : (
              <>
                <Link className="button primary" to="/signup">Create an account</Link>
                <Link className="button raised" to="/signin">Sign in</Link>
              </>
            )}
          </div>
        </div>
        <div className="well" aria-hidden="true" />
      </section>
      <section className="steps">
        {steps.map(([title, text], i) => (
          <div className="card step" key={title}>
            <span>0{i + 1}</span>
            <b>{title}</b>
            <span>{text}</span>
          </div>
        ))}
      </section>
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

function Account({ me, onSignOut }: { me: Who; onSignOut: () => void }) {
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
        <button className="button raised" onClick={onSignOut}>Sign out</button>
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
    "/account": <Account me={me} onSignOut={signOut} />,
  };
  return (
    <div className="page">
      <Header path={path} me={me} onSignOut={signOut} />
      <main>{pages[cleanPath(path)] || <NotFound />}</main>
      <footer className="footer mt-4 text-accent-ink">
        <span>© Caller Whale</span>
        <Link to="/pricing">Pricing</Link>
      </footer>
    </div>
  );
}
