import "@fontsource-variable/schibsted-grotesk";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createAuth } from "./auth/auth-client.js";
import { HumanCheck } from "./auth/human-check.jsx";
import { cleanPath, redirectFor } from "./guard.js";
import "./styles.css";

// Anything that changes who is signed in (new tokens, a refresh the server refused, signing out) tells the page.
const listeners = new Set();
const auth = createAuth({
  base: import.meta.env.VITE_CALLERWHALE_AUTH_URL || "http://localhost:8101",
  onChange: () => listeners.forEach(listener => listener()),
});
const getAuth = async () => auth;
// Where the auth client keeps the refresh token: another tab signing in or out changes it.
const REFRESH_KEY = "callerwhale.auth.refresh";

function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const sync = () => setPath(location.pathname);
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  return path;
}
const go = (to, { replace = false } = {}) => {
  history[replace ? "replaceState" : "pushState"](null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
};
function Link({ to, children, ...rest }) {
  return (
    <a
      href={to}
      onClick={e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        e.preventDefault();
        go(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** Who is signed in: undefined while asking, null when nobody. */
function useMe() {
  const [me, setMe] = useState(auth.signedIn() ? undefined : null);
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
    const changed = event => {
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
  return [me, setMe];
}

function Header({ path, me, onSignOut }) {
  const current = to => (path === to ? "page" : undefined);
  return (
    <header className="header">
      <Link to="/" className="brand">
        <img src="/favicon.svg" alt="" />
        Caller Whale
      </Link>
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

function Home({ me }) {
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

function Field({ label, ...input }) {
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
  const run = async fn => {
    setState({ busy: true, error: "", info: "" });
    try {
      const info = await fn();
      setState({ busy: false, error: "", info: info || "" });
      return true;
    } catch (error) {
      setState({ busy: false, error: error.message || "Something went wrong. Try again.", info: "" });
      return false;
    }
  };
  return [state, run];
}

function Providers({ action, human }) {
  const [list, setList] = useState({});
  const [state, run] = useAction();
  useEffect(() => {
    auth.providers().then(setList, () => {});
  }, []);
  if (!list.google) return null;
  return (
    <>
      <button type="button" className="button raised" disabled={state.busy} onClick={() => run(() => auth.startProvider("google", "landing", human, action))}>
        Continue with Google
      </button>
      {state.error && <p className="notice bad" role="alert">{state.error}</p>}
    </>
  );
}

function SignIn({ onDone, notice }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [human, setHuman] = useState("");
  const [state, run] = useAction();
  const submit = async e => {
    e.preventDefault();
    const ok = await run(async () => {
      try {
        await auth.signIn(email, password, code || undefined, "browser", human);
      } catch (error) {
        if (error.code === "mfa_required") {
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
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
        {needCode && <Field label="Code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={e => setCode(e.target.value)} />}
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

function SignUp({ onDone }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [human, setHuman] = useState("");
  const [state, run] = useAction();
  const submit = async e => {
    e.preventDefault();
    if (await run(() => auth.signUp(name, email, password, "browser", human))) onDone();
  };
  return (
    <div className="form-wrap">
      <form className="form card" onSubmit={submit}>
        <h1>Create your account</h1>
        <Field label="Name" autoComplete="name" required value={name} onChange={e => setName(e.target.value)} />
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} />
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
  const submit = e => {
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
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
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

function Account({ me, onSignOut }) {
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

function App() {
  const path = useRoute();
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
  const pages = {
    "/": <Home me={me} />,
    "/signin": <SignIn onDone={signedIn} notice={notice} />,
    "/signup": <SignUp onDone={signedIn} />,
    "/forgot": <Forgot />,
    "/account": <Account me={me} onSignOut={signOut} />,
  };
  return (
    <div className="page">
      <Header path={path} me={me} onSignOut={signOut} />
      <main>{pages[cleanPath(path)] || <Home me={me} />}</main>
      <footer className="footer">© Caller Whale</footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
