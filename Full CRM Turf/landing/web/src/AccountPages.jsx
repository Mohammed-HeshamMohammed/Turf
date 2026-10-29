import { useEffect, useState } from "react";
import { DownloadSimple, EnvelopeSimple, LockKey, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { API, homeFor, loadAuth, request, useSession } from "./session.jsx";

// Sign in, sign up, and the dashboard of a person Turf invited. The page decides nothing about access: Turf's server
// answers /account with what this person may see, and refuses everything else.

/** Google's own mark in its own colours. */
export const GoogleMark = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
    <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
    <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.8 3.6-4.9 6.7-4.9z" />
  </svg>
);

export const number = value => Number(value || 0).toLocaleString("en-US");
export const dateText = value => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
export const timeText = value => (value ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

/** Goes to another page of the site the way its links do. */
export const go = href => {
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
};

function Shell({ title, lead, children, wide }) {
  return (
    <section className={`section account ${wide ? "wide" : ""}`}>
      <div className="account-head">
        <h1>{title}</h1>
        {lead && <p className="sub">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

/** Sign in and sign up share one form: email and password, Google, and the authenticator code when one is set up. */
function AuthForm({ mode }) {
  const session = useSession();
  const [form, setForm] = useState({ name: "", email: "", password: "", code: "" });
  const [state, setState] = useState({ busy: false, error: "", note: "", needCode: false, google: false });
  const set = key => e => setForm({ ...form, [key]: e.target.value });
  const signup = mode === "signup";

  // Back from Google: finish that sign-in, then go where this person belongs.
  useEffect(() => {
    let live = true;
    loadAuth()
      .then(async auth => {
        if (live) setState(s => ({ ...s, google: auth.providerList.includes("google") }));
        const back = await auth.finishProvider();
        if (back && live) await arrive();
      })
      .catch(error => live && setState(s => ({ ...s, error: error.code === "mfa_required" ? "" : error.message, needCode: error.code === "mfa_required" })));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Already signed in: nothing to do here.
  useEffect(() => {
    if (session.status === "signed_in") go(homeFor(session.account));
  }, [session.status, session.account]);

  async function arrive() {
    const account = await session.reload();
    go(homeFor(account));
  }

  async function attempt(work) {
    setState(s => ({ ...s, busy: true, error: "", note: "" }));
    try {
      await work(await loadAuth());
      await arrive();
    } catch (error) {
      if (error.code === "mfa_required") setState(s => ({ ...s, busy: false, needCode: true, error: s.needCode ? error.message : "" }));
      else setState(s => ({ ...s, busy: false, error: error.message }));
      return;
    }
    setState(s => ({ ...s, busy: false }));
  }

  const onSubmit = e => {
    e.preventDefault();
    if (state.needCode) return attempt(auth => (form.password ? auth.signIn(form.email.trim(), form.password, form.code.trim()) : auth.verifyMfa(form.code.trim())));
    if (signup) {
      if (form.password.length < 12) return setState(s => ({ ...s, error: "Use a password of at least 12 characters." }));
      return attempt(auth => auth.signUp(form.name.trim(), form.email.trim(), form.password));
    }
    return attempt(auth => auth.signIn(form.email.trim(), form.password));
  };

  const google = () => {
    setState(s => ({ ...s, busy: true, error: "" }));
    // The page goes to Google and comes back here.
    loadAuth()
      .then(auth => auth.startProvider("google"))
      .catch(error => setState(s => ({ ...s, busy: false, error: error.message })));
  };

  const reset = async () => {
    if (!form.email.trim()) return setState(s => ({ ...s, error: "Enter your email first, then choose Forgot password." }));
    try {
      await (await loadAuth()).resetPassword(form.email.trim());
    } catch {
      /* Said the same way whether or not the address has an account. */
    }
    setState(s => ({ ...s, error: "", note: "If that address has an account, a link to choose a new password is on its way." }));
  };

  return (
    <Shell
      title={signup ? "Create your account" : "Sign in to Turf"}
      lead={signup ? "Turf is by invitation. Use the email address your invitation was sent to." : "Use the account your invitation was sent to."}
    >
      <div className="panel auth-panel">
        {state.google && !state.needCode && (
          <>
            <button type="button" className="button ghost google" onClick={google} disabled={state.busy}>
              <GoogleMark /> {signup ? "Sign up with Google" : "Sign in with Google"}
            </button>
            <p className="or"><span>or with your email</span></p>
          </>
        )}
        <form onSubmit={onSubmit} noValidate>
          {state.needCode ? (
            <label>
              Code from your authenticator app
              <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} autoFocus required value={form.code} onChange={set("code")} />
            </label>
          ) : (
            <>
              {signup && (
                <label>
                  Your name
                  <input autoComplete="name" value={form.name} onChange={set("name")} />
                </label>
              )}
              <label>
                Email
                <input type="email" required autoComplete="email" value={form.email} onChange={set("email")} />
              </label>
              <label>
                Password {signup && <span className="opt">(12 characters or more)</span>}
                <input type="password" required minLength={signup ? 12 : undefined} autoComplete={signup ? "new-password" : "current-password"} value={form.password} onChange={set("password")} />
              </label>
            </>
          )}
          {state.error && <p className="notice bad" role="alert">{state.error}</p>}
          {state.note && <p className="notice good" role="status">{state.note}</p>}
          <button className="button" type="submit" disabled={state.busy}>
            {state.busy ? "One moment…" : state.needCode ? "Confirm code" : signup ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="switch">
          {signup ? (
            <>Already have an account? <a href="/signin">Sign in</a></>
          ) : (
            <>
              New here? <a href="/signup">Create an account</a>
              <span aria-hidden="true"> · </span>
              <button type="button" className="text-button" onClick={reset}>Forgot password</button>
            </>
          )}
        </p>
      </div>
    </Shell>
  );
}

export const SignIn = () => <AuthForm mode="signin" />;
export const SignUp = () => <AuthForm mode="signup" />;

/** The download: a short-lived link from the server, for people it lets download only. */
export function DownloadButton({ release }) {
  const [state, setState] = useState({ busy: false, error: "" });
  const download = async () => {
    setState({ busy: true, error: "" });
    try {
      const link = await request("POST", "/api/v1/account/download");
      window.location.assign(`${API}${link.url}`);
      setState({ busy: false, error: "" });
    } catch (error) {
      setState({ busy: false, error: error.message });
    }
  };
  if (!release) return <p className="sub">The desktop app's first release is on its way. This page will offer it as soon as it is published.</p>;
  const mb = release.size ? ` · ${(release.size / 1048576).toFixed(0)} MB` : "";
  return (
    <div className="download">
      <button type="button" className="button" onClick={download} disabled={state.busy}>
        <DownloadSimple size={20} weight="bold" aria-hidden="true" /> {state.busy ? "Preparing…" : "Download Turf for Windows"}
      </button>
      <p className="sub">Version {release.version}{mb}. Sign in to the app with this same account.</p>
      {state.error && <p className="notice bad" role="alert">{state.error}</p>}
    </div>
  );
}

/** Credits used against the limit, as a bar and in words. */
export function Meter({ used, limit }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 1;
  const tone = share >= 1 ? "full" : share >= 0.8 ? "high" : "";
  return (
    <div className="meter" role="img" aria-label={`${number(used)} of ${number(limit)} credits used`}>
      <span className={tone} style={{ width: `${Math.round(share * 100)}%` }} />
    </div>
  );
}

/** One bar per day of the month that had usage. */
export function DayChart({ days, period }) {
  if (!days?.length) return <p className="sub">No credits used this month yet.</p>;
  const start = new Date(period.start);
  const end = new Date(period.end);
  const count = Math.round((end - start) / 86400000);
  const byDay = Object.fromEntries(days.map(d => [d.day, d.credits]));
  const max = Math.max(...days.map(d => d.credits), 1);
  const cells = Array.from({ length: count }, (_, i) => {
    const day = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    return { day, credits: byDay[day] || 0 };
  });
  return (
    <div className="days" role="list" aria-label="Credits used by day">
      {cells.map(c => (
        <span key={c.day} role="listitem" title={`${dateText(c.day + "T12:00:00Z")}: ${number(c.credits)} credits`} aria-label={`${c.day}: ${c.credits} credits`}>
          <i style={{ height: `${c.credits ? Math.max(6, (c.credits / max) * 100) : 0}%` }} />
        </span>
      ))}
    </div>
  );
}

export const KIND_LABELS = { skip_trace: "Skip Tracing" };

export function RecentUsage({ rows }) {
  if (!rows?.length) return null;
  return (
    <table className="table">
      <thead>
        <tr><th>When</th><th>What</th><th className="figure">Credits</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{timeText(r.at)}</td>
            <td>{KIND_LABELS[r.kind] || r.kind}{r.detail ? ` · ${r.detail}` : ""}</td>
            <td className="figure">{number(r.credits)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NeedSignIn() {
  return (
    <Shell title="Sign in to see this page">
      <div className="panel center-text">
        <p className="sub">Your dashboard opens once you sign in.</p>
        <div className="actions center-actions">
          <a className="button" href="/signin">Sign in</a>
          <a className="button ghost" href="/signup">Create an account</a>
        </div>
      </div>
    </Shell>
  );
}

export function Gate({ children }) {
  const session = useSession();
  if (session.status === "unknown") return <Shell title="One moment…" />;
  if (session.status === "signed_out") return <NeedSignIn />;
  if (session.status === "error") {
    return (
      <Shell title="We could not open your account">
        <div className="panel">
          <p className="notice bad" role="alert">
            {session.error?.status === 401 ? "Turf's server did not accept your sign-in. If your access was suspended, contact Turf." : session.error?.message}
          </p>
          <div className="actions">
            <button type="button" className="button" onClick={() => session.reload().catch(() => {})}>Try again</button>
            <button type="button" className="button ghost" onClick={session.signOut}>Sign out</button>
          </div>
        </div>
      </Shell>
    );
  }
  return children(session);
}

function ConfirmEmail({ session }) {
  const [state, setState] = useState({ busy: false, note: "", error: "" });
  const resend = async () => {
    setState({ busy: true, note: "", error: "" });
    try {
      await (await loadAuth()).resendEmail();
      setState({ busy: false, note: "A new confirmation email is on its way.", error: "" });
    } catch (error) {
      setState({ busy: false, note: "", error: error.message });
    }
  };
  const confirmed = async () => {
    setState({ busy: true, note: "", error: "" });
    // A fresh token says the address is confirmed now.
    await (await loadAuth()).refresh().catch(() => null);
    const account = await session.reload().catch(() => null);
    setState({ busy: false, note: "", error: account?.access?.status === "unverified" ? "Your address is not confirmed yet. Open the link in the email first." : "" });
  };
  return (
    <div className="panel">
      <h2><EnvelopeSimple size={22} weight="duotone" aria-hidden="true" /> Confirm your email address</h2>
      <p className="sub">
        You have an invitation. Open the confirmation link we sent to <strong>{session.account.person.email}</strong>, then come back. This proves the
        address is yours, so nobody else can use your invitation.
      </p>
      {state.error && <p className="notice bad" role="alert">{state.error}</p>}
      {state.note && <p className="notice good" role="status">{state.note}</p>}
      <div className="actions">
        <button type="button" className="button" onClick={confirmed} disabled={state.busy}>I have confirmed it</button>
        <button type="button" className="button ghost" onClick={resend} disabled={state.busy}>Send the email again</button>
      </div>
    </div>
  );
}

export function Dashboard() {
  return (
    <Gate>
      {session => {
        const { account } = session;
        const access = account.access;
        const name = account.person.name || account.person.email;
        if (!access && account.staff) {
          return (
            <Shell title={`Welcome, ${name}`} lead="You are on Turf's staff.">
              <div className="panel">
                <p className="sub">Invite people, set their limits and watch their usage on the admin pages.</p>
                <div className="actions"><a className="button" href="/admin">Open admin</a></div>
                <h2>Desktop app</h2>
                <DownloadButton release={account.release} />
              </div>
            </Shell>
          );
        }
        if (!access) {
          return (
            <Shell title="You are signed in" lead={account.person.email}>
              <div className="panel">
                <h2><LockKey size={22} weight="duotone" aria-hidden="true" /> Turf is by invitation</h2>
                <p className="sub">
                  This account has no invitation, so there is no dashboard or download for it. If you were invited, sign in with the email address the
                  invitation was sent to. Otherwise, join the waitlist and we will let you know.
                </p>
                <div className="actions">
                  <a className="button" href="/#waitlist">Join the waitlist</a>
                  <button type="button" className="button ghost" onClick={session.signOut}>Sign out</button>
                </div>
              </div>
            </Shell>
          );
        }
        if (access.status === "unverified" || access.status === "invited") {
          return (
            <Shell title={`Welcome, ${name}`}>
              <ConfirmEmail session={session} />
            </Shell>
          );
        }
        const usage = access.usage;
        return (
          <Shell title={`Welcome, ${name}`} lead={`Your credits for ${new Date(access.period.start).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}.`} wide>
            <div className="stats">
              <div className="stat"><span>Used this month</span><strong>{number(access.used_this_month)}</strong></div>
              <div className="stat"><span>Monthly limit</span><strong>{number(access.monthly_credits)}</strong></div>
              <div className="stat"><span>Left</span><strong>{number(access.remaining)}</strong></div>
              <div className="stat"><span>Renews</span><strong>{dateText(access.period.end)}</strong></div>
            </div>
            <div className="panel">
              <Meter used={access.used_this_month} limit={access.monthly_credits} />
              <p className="sub small">One credit is one row checked by Skip Tracing. When the month's credits are used up, the app waits for the next month or a higher limit from Turf.</p>
              <DayChart days={usage.days} period={usage.period} />
            </div>
            <div className="split">
              <div className="panel">
                <h2><DownloadSimple size={22} weight="duotone" aria-hidden="true" /> The desktop app</h2>
                <DownloadButton release={account.release} />
              </div>
              <div className="panel">
                <h2><ShieldCheck size={22} weight="duotone" aria-hidden="true" /> Your access</h2>
                <p className="sub">Invited and active since {dateText(access.accepted_at)}. Signed in as {account.person.email}.</p>
                <button type="button" className="button ghost small" onClick={session.signOut}>Sign out</button>
              </div>
            </div>
            {usage.recent?.length > 0 && (
              <div className="panel">
                <h2>Latest usage</h2>
                <RecentUsage rows={usage.recent} />
              </div>
            )}
          </Shell>
        );
      }}
    </Gate>
  );
}

export function Problem({ children }) {
  return (
    <p className="notice bad" role="alert">
      <WarningCircle size={18} weight="bold" aria-hidden="true" /> {children}
    </p>
  );
}
