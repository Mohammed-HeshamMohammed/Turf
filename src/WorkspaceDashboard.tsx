import { useEffect, useState } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { Link } from "./nav.tsx";
import type { Access } from "./RoleBadges.tsx";
import { InviteManager, PendingInvitations, WorkspaceManager } from "./AccessManagement.tsx";
import { Settings } from "./Settings.tsx";
import { profilePath } from "./profile-path.ts";
import { crmUrl } from "./crm-url.ts";

const gateway = (import.meta.env.VITE_CALLERWHALE_GATEWAY_URL || "https://gate.callerwhale.com").replace(/\/$/, "");

type View = "overview" | "team" | "invitations" | "activity" | "account";
type Plan = { plan: string; plan_name?: string; status?: string; period_end?: string; seats?: number; minutes_allowed?: number; minutes_used?: number; limited: boolean; payment_required: boolean };
type Person = { user_id: string; name: string; roles: string[]; team_name: string; suspended: boolean };
type Totals = { user_id: string; dials: number; connects: number; qualified: number; callbacks: number; bad_numbers: number; do_not_call: number; leads_worked: number; leads_held: number; tasks_done: number; tasks_open: number; tasks_overdue: number; notes: number; last_active?: string };

const ROLE_NAMES: Record<string, string> = { owner: "Agency owner", solo: "Solo operator", manager: "Team lead", admin: "Admin", researcher: "Data researcher", caller: "Caller", closer: "Acquisitions / closer", client: "Client" };
const initials = (text: string) => (text.split("@")[0].split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("") || "?").toUpperCase();
const firstNameOf = (me: Me) => String(me.first_name || "").trim() || (me.name || "").trim().split(/\s+/)[0] || me.email;
const viewFromHash = (hash: string): View => (["team", "invitations", "activity", "account"].includes(hash.slice(1)) ? (hash.slice(1) as View) : "overview");
const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const when = (value?: string) => (value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

async function authCall(auth: Auth, base: string, path: string) {
  const token = await auth.accessToken();
  if (!token) throw new Error("Sign in again to continue.");
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || "That could not be loaded.");
  return body;
}

/** The workspace's plan as its owner sees it, the people in it, and what is waiting. */
function WorkspaceOverview({ auth, authBase, orgId, owner, open }: { auth: Auth; authBase: string; orgId: string; owner: boolean; open: (view: View) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState("");
  const [people, setPeople] = useState<{ members: { roles: string[]; suspended_at?: number }[]; teams: unknown[] } | null>(null);
  useEffect(() => {
    authCall(auth, authBase, `/v1/orgs/${orgId}/standing`).then(setPlan, error => setPlanError(error.message));
    authCall(auth, authBase, `/v1/orgs/${orgId}/members`).then(setPeople, () => setPeople(null));
  }, [auth, authBase, orgId]);
  const working = people?.members.filter(person => !(person.roles.length === 1 && person.roles[0] === "client")) || [];
  const clients = (people?.members.length || 0) - working.length;
  const suspended = people?.members.filter(person => person.suspended_at).length || 0;
  return <div className="dashboard-page">
    <PendingInvitations auth={auth} authBase={authBase} />
    <div className="dashboard-panels">
      <section className="card" aria-labelledby="ws-plan">
        <h2 id="ws-plan">Plan</h2>
        {planError ? <p className="muted">{planError}</p> : !plan ? <p className="muted" role="status">Loading…</p> : !plan.plan ? <p className="muted">No plan yet. Caller Whale gives your workspace its plan.</p> : <>
          <p><strong>{plan.plan_name || plan.plan}</strong><br /><span className="muted">{plan.payment_required ? "Ended: ask Caller Whale to renew it" : plan.status === "trialing" ? "Trial" : "Active"}{plan.period_end ? ` · until ${new Date(plan.period_end).toLocaleDateString()}` : ""}</span></p>
          <p className="muted">{plan.seats ? `${working.length} of ${plan.seats} seats used` : `${working.length} people`}{plan.minutes_allowed ? ` · ${plan.minutes_allowed.toLocaleString()} calling minutes a month` : ""}</p>
        </>}
      </section>
      <section className="card" aria-labelledby="ws-people">
        <h2 id="ws-people">People</h2>
        {!people ? <p className="muted" role="status">Loading…</p> : <p><strong>{working.length}</strong> working{owner ? ` · ${people.teams.length} ${people.teams.length === 1 ? "team" : "teams"}` : ""}{clients ? ` · ${clients} ${clients === 1 ? "client" : "clients"}` : ""}{suspended ? ` · ${suspended} suspended` : ""}</p>}
        <button type="button" className="staff-text-button" onClick={() => open("team")}>{owner ? "Manage teams and members →" : "See your team →"}</button>
      </section>
      <section className="card" aria-labelledby="ws-work">
        <h2 id="ws-work">Work</h2>
        <p className="muted">Leads, calls, tasks and lists are in the CRM.</p>
        <a className="button primary" href={crmUrl}>Open the CRM</a>
        <button type="button" className="staff-text-button" onClick={() => open("activity")}>See what everyone did →</button>
      </section>
    </div>
  </div>;
}

/** What each person did over a range of days, from the CRM: the owner sees everyone, a team manager their own callers and closers. */
function TeamActivity({ auth, orgId }: { auth: Auth; orgId: string }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<{ people: Person[]; totals: Totals[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const to = new Date();
    const from = new Date(to);
    from.setDate(to.getDate() - (days - 1));
    setError(""); setData(null);
    auth.accessToken().then(async token => {
      const response = await fetch(`${gateway}/api/v1/stats/members?from=${day(from)}&to=${day(to)}`, { headers: { Authorization: `Bearer ${token}`, "x-callerwhale-org": orgId } });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || "The team's numbers could not be loaded.");
      return body;
    }).then(body => live && setData(body), cause => live && setError(cause instanceof Error ? cause.message : "The team's numbers could not be loaded."));
    return () => { live = false; };
  }, [auth, orgId, days]);
  const totals = new Map((data?.totals || []).map(row => [row.user_id, row]));
  const rows = (data?.people || []).map(person => ({ ...person, ...(totals.get(person.user_id) || {}) })) as (Person & Partial<Totals>)[];
  const n = (value?: number) => (value || 0).toLocaleString();
  return <section className="admin-manage card" aria-labelledby="ws-activity">
    <div className="admin-section-heading"><div><span className="eyebrow">Monitoring</span><h2 id="ws-activity">What everyone did</h2><p className="muted">Counted from calls, notes and tasks in the CRM.</p></div>
      <div className="settings-tabs" role="tablist" aria-label="Range">{[[1, "Today"], [7, "7 days"], [30, "30 days"]].map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={days === value} className={days === value ? "is-current" : ""} onClick={() => setDays(Number(value))}>{label}</button>)}</div></div>
    {error ? <p className="notice bad" role="alert">{error}</p> : !data ? <p className="muted" role="status">Counting…</p> : rows.length === 0 ? <p className="muted">Nobody to show yet.</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Person</th><th>Calls</th><th>Reached</th><th>Qualified</th><th>Callbacks</th><th>Wrong / DNC</th><th>Leads held</th><th>Tasks done</th><th>Open tasks</th><th>Last active</th></tr></thead><tbody>{rows.map(row => <tr key={row.user_id}>
      <td>{row.name}<small className="admin-member-email">{row.roles.map(role => ROLE_NAMES[role] || role).join(", ")}{row.team_name ? ` · ${row.team_name}` : ""}{row.suspended ? " · Suspended" : ""}</small></td>
      <td>{n(row.dials)}</td><td>{n(row.connects)} <small>{percent(row.connects || 0, row.dials || 0)}</small></td><td>{n(row.qualified)}</td><td>{n(row.callbacks)}</td>
      <td>{n(row.bad_numbers)} / {n(row.do_not_call)}</td><td>{n(row.leads_held)}</td><td>{n(row.tasks_done)}</td><td>{n(row.tasks_open)}{row.tasks_overdue ? <small> {row.tasks_overdue} overdue</small> : null}</td><td>{when(row.last_active)}</td>
    </tr>)}</tbody></table></div>}
  </section>;
}

/** The dashboard of an agency owner, solo operator or team manager: a sidebar with their workspace's overview, team, invitations
 * (owner), activity, profile and settings. */
export function WorkspaceDashboard({ access, auth, authBase, me, onSaved }: { access: Access; auth: Auth; authBase: string; me: Me; onSaved: () => void }) {
  const spaces = access.workspaces.filter(space => space.business_owner || space.roles.includes("manager") || space.roles.includes("admin"));
  const [orgId, setOrgId] = useState(spaces[0]?.org_id || "");
  const [view, setView] = useState<View>(() => (typeof window === "undefined" ? "overview" : viewFromHash(window.location.hash)));
  useEffect(() => {
    const follow = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const space = spaces.find(item => item.org_id === orgId) || spaces[0];
  const owner = Boolean(space?.business_owner) || Boolean(space?.roles.includes("admin"));
  // The owner and admins invite anyone; a team lead invites callers, closers and researchers into the teams they lead (step 3).
  const canInvite = owner || Boolean(space?.roles.includes("manager"));
  const solo = Boolean(space?.roles.includes("solo"));
  const open = (next: View) => { window.history.replaceState(null, "", next === "overview" ? window.location.pathname : `#${next}`); setView(next); window.scrollTo(0, 0); };
  const titles: Record<View, string> = { overview: "Overview", team: owner ? (solo ? "Clients" : "Teams and members") : "Your team", invitations: "Invitations", activity: "Activity", account: "Settings" };
  const link = (key: View, label: string) => <a href={`#${key}`} aria-current={view === key ? "page" : undefined} onClick={event => { event.preventDefault(); open(key); }}>{label}</a>;
  return <div className="admin-layout">
    <div className="admin-sidebar-slot"><aside className="admin-sidebar" aria-label="Workspace navigation">
      <div className="admin-sidebar-brand"><span className="admin-sidebar-mark" aria-hidden="true">{me.avatar ? <img src={String(me.avatar)} alt="" /> : initials(me.name || me.email)}</span><span><strong>{space?.business_owner ? (solo ? "Solo operator" : "Agency owner") : space?.roles.includes("admin") ? "Admin" : "Team lead"}</strong><small>{firstNameOf(me)}</small></span></div>
      {spaces.length > 1 && <label className="admin-sidebar-note">Workspace<select value={space?.org_id} onChange={event => setOrgId(event.target.value)}>{spaces.map((item, index) => <option key={item.org_id} value={item.org_id}>Workspace {index + 1}</option>)}</select></label>}
      <nav aria-label="Dashboard sections">
        {link("overview", "Overview")}
        {link("team", owner ? (solo ? "Clients" : "Teams and members") : "Your team")}
        {canInvite && link("invitations", "Invitations")}
        {link("activity", "Activity")}
        <a href={crmUrl}>Open the CRM</a>
        <Link to={profilePath(me)}>Profile</Link>
        {link("account", "Settings")}
      </nav>
    </aside></div>
    <div className="admin-main"><section className={`admin-workspace admin-view-${view}`} aria-labelledby="ws-title">
      <header className="admin-view-header"><h1 id="ws-title">{titles[view]}</h1></header>
      {!space ? <p className="muted">You do not run a workspace yet.</p> : <>
        {view === "overview" && <WorkspaceOverview key={space.org_id} auth={auth} authBase={authBase} orgId={space.org_id} owner={owner} open={open} />}
        {view === "team" && <WorkspaceManager key={space.org_id} auth={auth} authBase={authBase} orgId={space.org_id} />}
        {view === "invitations" && canInvite && <InviteManager key={space.org_id} auth={auth} authBase={authBase} scope="workspace" orgId={space.org_id} />}
        {view === "activity" && <TeamActivity key={space.org_id} auth={auth} orgId={space.org_id} />}
        {view === "account" && <Settings embedded me={me} auth={auth} authBase={authBase} onSaved={onSaved} />}
      </>}
    </section></div>
  </div>;
}
