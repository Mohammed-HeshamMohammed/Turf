import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, PaperPlaneTilt, ShieldCheck, UserPlus } from "@phosphor-icons/react";
import { DayChart, DownloadButton, Gate, GoogleMark, Meter, Problem, RecentUsage, dateText, go, number, timeText } from "./AccountPages.jsx";
import { loadAuth, request } from "./session.jsx";

// Turf's staff: invite people to the desktop app with a monthly credit limit, see who registered and what they used,
// change limits, suspend and reactivate. Everything comes from Turf's server, which refuses anyone who is not staff,
// and staff who have not confirmed their authenticator code.

const STATUS_TEXT = { invited: "Invited", active: "Active", suspended: "Suspended" };

/** Staff must confirm an authenticator code: set one up here, or sign in again with one. */
function Authenticator({ onDone }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState("");
  const [state, setState] = useState({ busy: false, error: "" });
  const start = async () => {
    setState({ busy: true, error: "" });
    try {
      const auth = await loadAuth();
      const me = await auth.me();
      if (me.mfa_enrolled) {
        // Already set up: this sign-in just did not use it. Sign in again with a code.
        await auth.signOut();
        go("/signin");
        return;
      }
      setSetup(await auth.setupMfa());
      setState({ busy: false, error: "" });
    } catch (error) {
      setState({ busy: false, error: error.message });
    }
  };
  const confirm = async e => {
    e.preventDefault();
    setState({ busy: true, error: "" });
    try {
      await (await loadAuth()).confirmMfa(code.trim());
      onDone();
    } catch (error) {
      if (error.code === "signin_again") {
        go("/signin");
        return;
      }
      setState({ busy: false, error: error.message });
    }
  };
  return (
    <div className="panel">
      <h2><ShieldCheck size={22} weight="duotone" aria-hidden="true" /> Confirm it is you</h2>
      <p className="sub">The admin pages need a code from an authenticator app (Google Authenticator, 1Password, Authy…) every time you sign in.</p>
      {!setup ? (
        <button type="button" className="button" onClick={start} disabled={state.busy}>Set up or use my authenticator</button>
      ) : (
        <form onSubmit={confirm} noValidate>
          <p className="sub">
            Add this key to your authenticator app, or open the link on the phone that has it: <code className="key">{setup.secret}</code>{" "}
            <a href={setup.otpauth_url}>Open in authenticator</a>
          </p>
          <label>
            The 6-digit code it shows
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={e => setCode(e.target.value)} />
          </label>
          <button className="button" type="submit" disabled={state.busy}>Turn it on</button>
        </form>
      )}
      {state.error && <Problem>{state.error}</Problem>}
    </div>
  );
}

function InviteForm({ onInvited }) {
  const blank = { email: "", name: "", monthly_credits: "1000", note: "" };
  const [form, setForm] = useState(blank);
  const [state, setState] = useState({ busy: false, error: "", note: "" });
  const set = key => e => setForm({ ...form, [key]: e.target.value });
  const submit = async e => {
    e.preventDefault();
    const credits = Number(form.monthly_credits);
    if (!Number.isInteger(credits) || credits < 0) return setState({ busy: false, error: "Set the monthly credits as a whole number.", note: "" });
    setState({ busy: true, error: "", note: "" });
    try {
      const made = await request("POST", "/api/v1/platform/invitations", { email: form.email.trim(), name: form.name.trim(), monthly_credits: credits, note: form.note.trim() });
      setForm(blank);
      setState({
        busy: false,
        error: made.emailed ? "" : `Invited, but the email was not sent: ${made.email_error}`,
        note: made.emailed ? `Invitation sent to ${made.invitation.email}.` : "",
      });
      onInvited();
    } catch (error) {
      setState({ busy: false, error: error.message, note: "" });
    }
  };
  return (
    <form className="panel invite" onSubmit={submit} noValidate>
      <h2><UserPlus size={22} weight="duotone" aria-hidden="true" /> Invite someone</h2>
      <div className="fields">
        <label>
          Email
          <input type="email" required value={form.email} onChange={set("email")} />
        </label>
        <label>
          Name <span className="opt">(optional)</span>
          <input value={form.name} onChange={set("name")} />
        </label>
        <label>
          Credits a month
          <input type="number" min="0" step="1" required value={form.monthly_credits} onChange={set("monthly_credits")} />
        </label>
        <label>
          Note <span className="opt">(only staff see it)</span>
          <input value={form.note} onChange={set("note")} />
        </label>
      </div>
      {state.error && <Problem>{state.error}</Problem>}
      {state.note && <p className="notice good" role="status">{state.note}</p>}
      <button className="button" type="submit" disabled={state.busy}>
        <PaperPlaneTilt size={18} weight="bold" aria-hidden="true" /> {state.busy ? "Sending…" : "Send invitation"}
      </button>
    </form>
  );
}

function Person({ row, onChanged }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(String(row.monthly_credits));
  const [usage, setUsage] = useState(null);
  const [state, setState] = useState({ busy: false, error: "", note: "" });
  useEffect(() => setLimit(String(row.monthly_credits)), [row.monthly_credits]);

  const act = async (work, note = "") => {
    setState({ busy: true, error: "", note: "" });
    try {
      const result = await work();
      setState({ busy: false, error: result?.email_error || "", note: result?.email_error ? "" : note });
      onChanged();
    } catch (error) {
      setState({ busy: false, error: error.message, note: "" });
    }
  };
  const path = `/api/v1/platform/invitations/${row.id}`;
  const saveLimit = () => {
    const credits = Number(limit);
    if (!Number.isInteger(credits) || credits < 0) return setState({ busy: false, error: "Set the limit as a whole number.", note: "" });
    return act(() => request("PATCH", path, { monthly_credits: credits }), "Limit saved.");
  };
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) setUsage(await request("GET", `${path}/usage`).catch(error => ({ error: error.message })));
  };
  return (
    <>
      <tr className={row.status}>
        <td>
          <button type="button" className="text-button person" onClick={toggle} aria-expanded={open}>
            <strong>{row.name || row.email}</strong>
            {row.name && <span>{row.email}</span>}
          </button>
        </td>
        <td>
          <span className={`pill ${row.status}`}>{STATUS_TEXT[row.status]}</span>
          {row.sign_in === "google" && <span className="signin-mark" title="Signs in with Google"><GoogleMark size={14} /></span>}
        </td>
        <td className="usage-cell">
          <span className="figure">{number(row.used_this_month)} / {number(row.monthly_credits)}</span>
          <Meter used={row.used_this_month} limit={row.monthly_credits} />
        </td>
        <td>{row.last_used_at ? timeText(row.last_used_at) : row.accepted_at ? "Not yet" : "—"}</td>
        <td>{row.accepted_at ? `Joined ${dateText(row.accepted_at)}` : row.emailed_at ? `Emailed ${dateText(row.emailed_at)}` : "Not emailed"}</td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={5}>
            <div className="detail-body">
              <div className="controls">
                <label>
                  Credits a month
                  <span className="inline">
                    <input type="number" min="0" step="1" value={limit} onChange={e => setLimit(e.target.value)} />
                    <button type="button" className="button small" onClick={saveLimit} disabled={state.busy || limit === String(row.monthly_credits)}>Save</button>
                  </span>
                </label>
                <div className="actions">
                  {row.status === "active" && <button type="button" className="button ghost small" onClick={() => act(() => request("PATCH", path, { status: "suspended" }), "Suspended. They are signed out of the app at its next request.")} disabled={state.busy}>Suspend</button>}
                  {row.status === "suspended" && <button type="button" className="button small" onClick={() => act(() => request("PATCH", path, { status: "active" }), "Reactivated.")} disabled={state.busy}>Reactivate</button>}
                  {row.status !== "suspended" && <button type="button" className="button ghost small" onClick={() => act(() => request("POST", `${path}/resend`), "Email sent again.")} disabled={state.busy}>Resend email</button>}
                  {row.status === "invited" && <button type="button" className="button ghost small danger" onClick={() => act(() => request("DELETE", path), "Withdrawn.")} disabled={state.busy}>Withdraw</button>}
                </div>
              </div>
              {state.error && <Problem>{state.error}</Problem>}
              {state.note && <p className="notice good" role="status">{state.note}</p>}
              <p className="sub small">
                Invited by {row.invited_by} on {dateText(row.created_at)}. {row.registered ? "Has an account." : "Has not created an account yet."} Used {number(row.used_total)} credits in all.
                {row.note ? ` Note: ${row.note}` : ""}
              </p>
              {usage?.error && <Problem>{usage.error}</Problem>}
              {usage?.usage && (
                <>
                  <DayChart days={usage.usage.days} period={usage.usage.period} />
                  <RecentUsage rows={usage.usage.recent} />
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Invitations({ account }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");
  const load = useCallback(() => {
    request("GET", "/api/v1/platform/invitations")
      .then(d => {
        setData(d);
        setError(null);
      })
      .catch(setError);
  }, []);
  useEffect(load, [load]);

  if (error?.code === "mfa_required") return <Authenticator onDone={load} />;
  if (error) return <Problem>{error.message}</Problem>;
  if (!data) return <p className="sub">Loading…</p>;
  const q = filter.trim().toLowerCase();
  const rows = data.invitations.filter(r => !q || r.email.includes(q) || r.name.toLowerCase().includes(q));
  return (
    <>
      <div className="stats">
        <div className="stat"><span>Active</span><strong>{number(data.totals.active)}</strong></div>
        <div className="stat"><span>Invited, not joined</span><strong>{number(data.totals.invited)}</strong></div>
        <div className="stat"><span>Suspended</span><strong>{number(data.totals.suspended)}</strong></div>
        <div className="stat"><span>Credits used this month</span><strong>{number(data.totals.used_this_month)}</strong></div>
      </div>
      {!data.mail && <Problem>No mail server is set up on Turf's server, so invitations are saved but not emailed. Set TURF_SMTP_HOST and its login.</Problem>}
      <InviteForm onInvited={load} />
      <div className="panel">
        <div className="table-head">
          <h2>People</h2>
          <input type="search" placeholder="Search by name or email" aria-label="Search people" value={filter} onChange={e => setFilter(e.target.value)} />
          <button type="button" className="button ghost small" onClick={load} aria-label="Refresh"><ArrowClockwise size={16} weight="bold" aria-hidden="true" /></button>
        </div>
        {rows.length === 0 ? (
          <p className="sub">{data.invitations.length ? "Nobody matches." : "Nobody is invited yet."}</p>
        ) : (
          <div className="table-wrap">
            <table className="table people">
              <thead>
                <tr><th>Person</th><th>Status</th><th>This month</th><th>Last used</th><th>Invitation</th></tr>
              </thead>
              <tbody>
                {rows.map(row => <Person key={row.id} row={row} onChanged={load} />)}
              </tbody>
            </table>
          </div>
        )}
        <p className="sub small">Credits are counted per calendar month (UTC). Select a person to change their limit, suspend them or see their usage.</p>
      </div>
      <div className="panel">
        <h2>Desktop app</h2>
        <DownloadButton release={account.release} />
      </div>
    </>
  );
}

export function Admin() {
  return (
    <Gate>
      {session => {
        if (!session.account.staff) {
          return (
            <section className="section account">
              <div className="panel">
                <h1>Staff only</h1>
                <p className="sub">This page is for Turf's staff.</p>
                <a className="button" href="/dashboard">Go to your dashboard</a>
              </div>
            </section>
          );
        }
        return (
          <section className="section account wide">
            <div className="account-head">
              <h1>Admin</h1>
              <p className="sub">Signed in as {session.account.person.email} ({session.account.staff.role === "owner" ? "platform owner" : "system administrator"}).</p>
            </div>
            <Invitations account={session.account} />
          </section>
        );
      }}
    </Gate>
  );
}
