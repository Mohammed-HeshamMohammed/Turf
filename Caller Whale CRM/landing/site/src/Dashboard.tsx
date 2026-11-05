import { useEffect, useState } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { Link } from "./nav.tsx";
import { RoleBadges, type Access } from "./RoleBadges.tsx";
import { PLATFORM_ROLES } from "./roles.ts";
import { ApiError, needsSecondStep, useSecondStep } from "./SecondStep.tsx";
import { CostsManager, MembersTable, PlatformOverview } from "./OwnerViews.tsx";
import { InviteManager, PendingInvitations, WorkspaceManager, WorkspaceSecondStep } from "./AccessManagement.tsx";
import { MonitoringPanel } from "./MonitoringPanel.tsx";

type StaffMember = { name: string; email?: string; role: string };
/** Up to two capital letters from a name or an email address: "Mohammed Hesham" is MH. */
const initials = (text: string) => (text.split("@")[0].split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("") || "?").toUpperCase();
/** Only the first name goes under the role in the sidebar: the saved one, or the first word of the display name. */
const firstNameOf = (me: { first_name?: unknown; name?: string; email: string }) => String(me.first_name || "").trim() || (me.name || "").trim().split(/\s+/)[0] || me.email;
const roleNames: Record<string, string> = Object.fromEntries(PLATFORM_ROLES.map(role => [role.key, role.name]));

const staffRoles = new Set(["owner", "cofounder", "system_admin"]);
type AdminView = "overview" | "team" | "members" | "access" | "costs" | "monitoring" | "account";
const viewFromHash = (hash: string): AdminView => {
  if (hash === "#team" || hash === "#admin-team") return "team";
  if (hash === "#access" || hash === "#admin-manage") return "access";
  if (hash === "#members") return "members";
  if (hash === "#costs") return "costs";
  if (hash === "#monitoring") return "monitoring";
  if (hash === "#account" || hash === "#admin-account") return "account";
  return "overview";
};
const resetDashboardScroll = () => {
  document.querySelector<HTMLElement>(".dashboard-shell > main")?.scrollTo(0, 0);
  window.scrollTo(0, 0);
};

function StaffDashboard({ access, auth, authBase, me }: { access: Access; auth: Auth; authBase: string; me: Me }) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "verify">(me.mfa_passed === false ? "verify" : "loading");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("system_admin");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupDetails, setSetupDetails] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [qrError, setQrError] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const canManage = access.platform_role === "owner" || access.platform_role === "cofounder";
  const [view, setView] = useState<AdminView>("overview");
  useEffect(() => {
    const sync = () => {
      const next = viewFromHash(location.hash);
      if ((next === "access" || next === "costs") && !canManage) {
        history.replaceState(null, "", "#overview");
        setView("overview");
      } else setView(next);
      resetDashboardScroll();
    };
    sync();
    addEventListener("popstate", sync);
    addEventListener("hashchange", sync);
    return () => { removeEventListener("popstate", sync); removeEventListener("hashchange", sync); };
  }, [canManage]);
  const openView = (next: AdminView) => {
    if (recovery.length) return;
    if (view === next && location.hash === `#${next}`) return;
    history.pushState(null, "", `#${next}`);
    setView(next);
    resetDashboardScroll();
  };
  const visibleStaff = staff.filter(person => {
    const matchesText = `${person.name} ${person.email || ""}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesText && (roleFilter === "all" || person.role === roleFilter);
  }).sort((a, b) => (a.name || a.email || "").localeCompare(b.name || b.email || ""));
  const editRole = (person: StaffMember) => {
    if (!person.email) return;
    setEmail(person.email);
    setRole(person.role);
    setMessage("");
    requestAnimationFrame(() => document.getElementById("staff-role-form")?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };
  const request = async (method: string, path: string, body?: object) => {
    const token = await auth.accessToken();
    if (!token) throw new Error("Sign in again to continue.");
    const response = await fetch(`${authBase}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => null) as { error?: string; code?: string } | null;
      // A second step done just now is asked for in place, so the screen keeps the code (step_up_required) and lets the person act on it.
      if (problem?.code === "step_up_required") throw new ApiError(problem.error || "Confirm it's you with your authenticator code.", problem.code);
      if (response.status === 403) throw new Error("A verified second step and the required staff role are needed.");
      throw new Error(problem?.error || "Staff information is unavailable. Try again.");
    }
    return response.json();
  };
  const load = async () => {
    setStatus("loading");
    try {
      const data = await request("GET", "/v1/admin/staff") as { staff: StaffMember[] };
      setStaff(data.staff);
      setStatus("ready");
    } catch (error) {
      setStatus(error instanceof Error && error.message.includes("second step") ? "verify" : "error");
    }
  };
  useEffect(() => {
    if (me.mfa_passed === false) { setStatus("verify"); return; }
    void load();
  }, [authBase, auth, access.platform_role, me.mfa_passed]);
  useEffect(() => {
    if (!setupDetails) { setQrCode(""); setQrError(false); return; }
    let active = true;
    setQrError(false);
    import("qrcode").then(({ toDataURL }) => toDataURL(setupDetails.otpauth_url, {
      errorCorrectionLevel: "M", margin: 2, width: 224, color: { dark: "#171d1a", light: "#ffffff" },
    })).then(url => { if (active) setQrCode(url); }, () => { if (active) setQrError(true); });
    return () => { active = false; };
  }, [setupDetails]);
  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setCopyMessage(`${label} copied.`); }
    catch { setCopyMessage("Copy is unavailable here. Select and copy the text instead."); }
  };
  const downloadRecovery = () => {
    const url = URL.createObjectURL(new Blob([`Caller Whale recovery codes\n\n${recovery.join("\n")}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "caller-whale-recovery-codes.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const second = useSecondStep(auth, "Changing a staff role needs a code entered just now.");
  const assign = (event: React.FormEvent) => {
    event.preventDefault();
    return second.guard(async () => {
      setBusy(true); setMessage("");
      try {
        await request("POST", "/v1/admin/staff", { email: email.trim(), role });
        setEmail("");
        setMessage(role ? "Staff role saved." : "Staff role removed.");
        await load();
      } catch (error) {
        if (needsSecondStep(error)) { setBusy(false); throw error; }
        setMessage(error instanceof Error ? error.message : "Could not save the role.");
      }
      setBusy(false);
    });
  };
  const setup = async () => {
    setMessage(""); setBusy(true);
    try { setSetupDetails(await auth.setupMfa()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not start authenticator setup."); }
    setBusy(false);
  };
  const confirm = async (event: React.FormEvent) => { event.preventDefault(); await confirmCode(code.trim()); };
  const confirmCode = async (value: string) => {
    setMessage(""); setBusy(true);
    try {
      if (setupDetails) setRecovery((await auth.confirmMfa(value)).recovery_codes);
      else await auth.verifyMfa(value);
      setCode(""); setSetupDetails(null); setCopyMessage("");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "That code could not be confirmed."); }
    setBusy(false);
  };
  const shownView = recovery.length ? "recovery" : view;
  const viewTitles = {
    overview: "Overview",
    team: "Platform team",
    members: "Members",
    access: "Manage access",
    costs: "Costs",
    monitoring: "Monitoring",
    account: "Your account",
    recovery: "Save your recovery codes",
  };
  return <div className="admin-layout">
    <div className="admin-sidebar-slot"><aside className="admin-sidebar" aria-label="Administration navigation"><div className="admin-sidebar-brand"><span className="admin-sidebar-mark" aria-hidden="true">{me.avatar ? <img src={String(me.avatar)} alt="" /> : initials(me.name || me.email)}</span><span><strong>{access.platform_role === "owner" ? "Owner" : roleNames[access.platform_role] || access.platform_label || "Staff"}</strong><small>{firstNameOf(me)}</small></span></div>{recovery.length ? <p className="admin-sidebar-note">Save your recovery codes to continue.</p> : <nav aria-label="Dashboard sections"><a href="#overview" aria-current={view === "overview" ? "page" : undefined} onClick={event => { event.preventDefault(); openView("overview"); }}>Overview</a><a href="#team" aria-current={view === "team" ? "page" : undefined} onClick={event => { event.preventDefault(); openView("team"); }}>Platform team</a><a href="#members" aria-current={view === "members" ? "page" : undefined} onClick={event => { event.preventDefault(); openView("members"); }}>Members</a>{canManage && <a href="#access" aria-current={view === "access" ? "page" : undefined} onClick={event => { event.preventDefault(); openView("access"); }}>Manage access</a>}{canManage && <a href="#costs" aria-current={view === "costs" ? "page" : undefined} onClick={event => { event.preventDefault(); openView("costs"); }}>Costs</a>}<a href="#monitoring" aria-current={view === "monitoring" ? "page" : undefined} onClick={event => { event.preventDefault(); openView("monitoring"); }}>Monitoring</a><a href="#account" aria-current={view === "account" ? "page" : undefined} onClick={event => { event.preventDefault(); openView("account"); }}>Your account</a></nav>}</aside></div>
    <div className="admin-main"><section className={`admin-workspace admin-view-${shownView}`} aria-labelledby="dashboard-administration">
    <header className="admin-view-header"><h1 id="dashboard-administration">{viewTitles[shownView]}</h1></header>
    {shownView !== "account" && !recovery.length && status === "loading" && <div className="admin-feedback card" role="status">Loading platform staff…</div>}
    {shownView !== "account" && !recovery.length && status === "verify" && <div className="staff-verify">
      <span className="eyebrow">Two-step security</span>
      <h3>{setupDetails ? "Connect your authenticator" : me.mfa_enrolled ? "Confirm it’s you" : "Protect your staff access"}</h3>
      <p className="muted">{setupDetails ? "Scan this QR code in your authenticator app, then enter its six-digit code below." : me.mfa_enrolled ? "Enter a code from your authenticator app to open the staff dashboard." : "Set up an authenticator app to open the staff dashboard. This takes about a minute."}</p>
      {!me.mfa_enrolled && !setupDetails && <button type="button" className="button primary" onClick={() => void setup()} disabled={busy}>{busy ? "Starting…" : "Set up authenticator"}</button>}
      {setupDetails && <div className="staff-setup">
        <div className="staff-qr">{qrCode ? <img src={qrCode} width="224" height="224" alt="QR code to add Caller Whale to your authenticator app" /> : <span role="status">{qrError ? "QR unavailable. Use the setup key instead." : "Preparing QR code…"}</span>}</div>
        <div className="staff-setup-instructions"><strong>Using the same phone?</strong><p>Choose “Enter a setup key” in your authenticator app. Use Caller Whale as the account name.</p><div className="staff-secret"><code>{setupDetails.secret}</code><button type="button" className="button raised" onClick={() => void copy(setupDetails.secret, "Setup key")}>Copy key</button></div><p className="fine">Keep this key private. The QR code contains the same key.</p></div>
      </div>}
      {(me.mfa_enrolled || setupDetails) && <form className="staff-code-form" onSubmit={confirm}>
        <label htmlFor="staff-auth-code">{useRecoveryCode && !setupDetails ? "Recovery code" : "Six-digit code"}</label>
        <div className="staff-code-row"><input id="staff-auth-code" inputMode={useRecoveryCode && !setupDetails ? "text" : "numeric"} autoComplete="one-time-code" required minLength={setupDetails || !useRecoveryCode ? 6 : undefined} maxLength={setupDetails || !useRecoveryCode ? 6 : undefined} pattern={setupDetails || !useRecoveryCode ? "[0-9]{6}" : undefined} placeholder={useRecoveryCode && !setupDetails ? "Enter a recovery code" : "000000"} value={code} onChange={event => { const digits = setupDetails || !useRecoveryCode; const value = digits ? event.target.value.replace(/\D/g, "").slice(0, 6) : event.target.value; setCode(value); if (digits && value.length === 6 && !busy) void confirmCode(value); }} /><button className="button primary" disabled={busy}>{busy ? "Checking…" : setupDetails ? "Finish setup" : "Verify and continue"}</button></div>
        {!setupDetails && <button type="button" className="staff-text-button" onClick={() => { setUseRecoveryCode(value => !value); setCode(""); }}>{useRecoveryCode ? "Use authenticator code instead" : "Use a recovery code instead"}</button>}
      </form>}
      {copyMessage && <p className="fine" role="status">{copyMessage}</p>}
      {message && <p className="notice bad" role="alert">{message}</p>}
    </div>}
    {recovery.length > 0 && <div className="staff-recovery" role="status"><span className="eyebrow">One-time backup</span><h3>Save your recovery codes</h3><p>These codes can restore staff access if you lose your authenticator. Each code works once. They will not be shown again after you leave this page.</p><ol>{recovery.map(value => <li key={value}><code>{value}</code></li>)}</ol><div className="staff-recovery-actions"><button type="button" className="button raised" onClick={() => void copy(recovery.join("\n"), "Recovery codes")}>Copy codes</button><button type="button" className="button raised" onClick={downloadRecovery}>Download text file</button></div>{copyMessage && <p className="fine" role="status">{copyMessage}</p>}<button type="button" className="button primary" onClick={() => { setRecovery([]); setCopyMessage(""); }}>I saved my codes</button></div>}
    {shownView !== "account" && !recovery.length && status === "error" && <div className="admin-feedback card" role="alert"><h2>Staff information is unavailable</h2><p>Check your connection and try again.</p><button type="button" className="button primary" onClick={() => void load()}>Try again</button></div>}
    {status === "ready" && shownView === "overview" && <><PlatformOverview request={request} openCosts={canManage ? () => openView("costs") : undefined} />{!canManage && <section className="admin-overview-panels" aria-label="Your access"><div className="card admin-overview-access"><span className="eyebrow">Your access</span><h2>{access.platform_label || roleNames[access.platform_role]}</h2><p className="muted">{canManage ? "You can invite staff and manage system admin and tester roles." : "You can review platform staff. Founder roles manage access."}</p><div className="admin-access-summary"><span>Access scope</span><strong>{canManage ? "Team administration" : "Staff directory"}</strong><small>{canManage ? "Invite staff and manage roles" : "Review platform staff"}</small></div>{canManage ? <button type="button" className="button raised" onClick={() => openView("access")}>Manage access →</button> : <button type="button" className="button raised" onClick={() => openView("account")}>View account →</button>}</div></section>}</>}
    {status === "ready" && shownView === "members" && <MembersTable request={request} canGive={canManage} auth={auth} />}
    {canManage && status === "ready" && shownView === "costs" && <CostsManager request={request} auth={auth} saved={String(me.currency || "")} />}
    {status === "ready" && shownView === "monitoring" && <MonitoringPanel auth={auth} />}
    {status === "ready" && shownView === "team" && <section className="admin-team card" aria-labelledby="admin-team-title"><div className="admin-section-heading"><div><span className="eyebrow">Access directory</span><h2 id="admin-team-title">Staff directory</h2><p className="muted">Owner and cofounder roles are permanent. System admin and tester roles can be managed here.</p></div><span className="admin-count">{query || roleFilter !== "all" ? `${visibleStaff.length} of ${staff.length}` : staff.length} {staff.length === 1 ? "person" : "people"}</span></div>
        <div className="admin-toolbar"><label>Search people<input type="search" placeholder="Name or email" value={query} onChange={event => setQuery(event.target.value)} /></label><label>Role<select value={roleFilter} onChange={event => setRoleFilter(event.target.value)}><option value="all">All roles</option><option value="owner">Owner</option><option value="cofounder">Cofounder</option><option value="system_admin">System admin</option><option value="tester">Tester</option></select></label></div>
        {staff.length === 0 ? <div className="admin-empty"><h3>No staff to show yet</h3><p>When an account receives platform access, it will appear here.</p>{canManage && <button type="button" className="button primary" onClick={() => document.getElementById("staff-role-form")?.scrollIntoView({ block: "center", behavior: "smooth" })}>Assign a role</button>}</div> : visibleStaff.length === 0 ? <div className="admin-empty"><h3>No matches</h3><p>Try a different name, email, or role.</p><button type="button" className="button raised" onClick={() => { setQuery(""); setRoleFilter("all"); }}>Clear filters</button></div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Access</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead><tbody>{visibleStaff.map((person, index) => <tr key={person.email || `${person.role}-${index}`}><td data-label="Person"><span className="admin-person"><span className="admin-person-avatar" aria-hidden="true">{(person.name || person.email || "?").charAt(0).toUpperCase()}</span><span><strong>{person.name || person.email}</strong>{person.email && <small>{person.email}</small>}</span></span></td><td data-label="Role"><span className={`staff-role staff-role-${person.role}`}>{roleNames[person.role] || person.role}</span></td><td data-label="Access">{person.role === "owner" || person.role === "cofounder" ? "Permanent" : "Managed"}</td><td data-label="Action">{canManage && person.email && (person.role === "system_admin" || person.role === "tester") && <button type="button" className="staff-text-button" onClick={() => editRole(person)}>Edit role</button>}</td></tr>)}</tbody></table></div>}
      </section>}
    {canManage && status === "ready" && shownView === "team" && <section id="staff-role-form" className="admin-manage card" aria-labelledby="admin-manage-title"><div><span className="eyebrow">Role management</span><h2 id="admin-manage-title">Change current staff roles</h2><p className="muted">Select a person in the staff directory, or enter the email of an account that has already signed in. Founder roles are permanent.</p></div>{second.prompt}<form className="staff-form" onSubmit={assign}><div className="staff-fields"><label>Account email<input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="person@example.com" /></label><label>Role<select value={role} onChange={event => setRole(event.target.value)}><option value="system_admin">System admin</option><option value="tester">Tester</option><option value="">Remove role</option></select></label><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save access"}</button></div>{message && <p className={message.includes("saved") || message.includes("removed") ? "notice" : "notice bad"} role="status">{message}</p>}</form></section>}
    {canManage && status === "ready" && shownView === "access" && <InviteManager auth={auth} authBase={authBase} scope="platform" />}
    {shownView === "account" && <><section className="admin-account card" aria-labelledby="admin-account-title"><div><span className="eyebrow">Your profile</span><h2 id="admin-account-title">{me.name || me.email}</h2><p className="muted">{me.email}</p><RoleBadges access={{ ...access, workspaces: [] }} /><Link to="/account">Manage your profile →</Link></div><div><h3>Workspace memberships</h3>{access.workspaces.length ? <ul className="membership-list">{access.workspaces.map((workspace, index) => <li key={workspace.org_id}><strong>Workspace {index + 1}</strong><RoleBadges access={{ platform_role: "", workspaces: [workspace] }} /></li>)}</ul> : <p className="muted">No workspace memberships yet.</p>}</div></section><PendingInvitations auth={auth} authBase={authBase} />{access.workspaces.filter(space => space.business_owner).map(space => <div className="workspace-access" key={space.org_id}><h2>Workspace access</h2><WorkspaceManager auth={auth} authBase={authBase} orgId={space.org_id} /><InviteManager auth={auth} authBase={authBase} scope="workspace" orgId={space.org_id} /></div>)}</>}
  </section></div></div>;
}

export function Dashboard({ me, auth, authBase }: { me: Me | null | undefined; auth: Auth; authBase: string }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!me) return;
    const controller = new AbortController();
    setStatus("loading");
    auth.accessToken().then(async token => {
      if (!token) throw new Error("No session");
      const response = await fetch(`${authBase}/v1/me/access`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Membership unavailable");
      return response.json() as Promise<Access>;
    }).then(profile => {
      if (controller.signal.aborted) return;
      setAccess(profile);
      setStatus("ready");
    }).catch(() => {
      if (!controller.signal.aborted) setStatus("unavailable");
    });
    return () => controller.abort();
  }, [me?.id, auth, authBase, retry]);

  if (!me) return <div className="form-wrap"><p className="muted">Loading your dashboard…</p></div>;
  if (status === "loading") return <div className="admin-feedback card" role="status"><h1>Preparing your dashboard</h1><p>Checking your account and access…</p></div>;
  if (status === "unavailable" || !access) return <div className="admin-feedback card" role="alert"><h1>We couldn’t load your dashboard</h1><p>Your account is signed in, but access details are unavailable right now.</p><button type="button" className="button primary" onClick={() => setRetry(value => value + 1)}>Try again</button></div>;
  if (staffRoles.has(access.platform_role)) return <StaffDashboard access={access} auth={auth} authBase={authBase} me={me} />;
  return <div className="dashboard-page">
    <header className="page-head">
      <span className="eyebrow">Your Caller Whale account</span>
      <h1>Your dashboard</h1>
      <p className="lead">Your account, platform role and workspace memberships in one place.</p>
    </header>
    <PendingInvitations auth={auth} authBase={authBase} />
    <div className="dashboard-panels">
      <section className="card" aria-labelledby="dashboard-account">
        <h2 id="dashboard-account">Account</h2>
        <p><strong>{me.name || me.email}</strong><br /><span className="muted">{me.email}</span></p>
        <Link to="/account">Your profile →</Link>
      </section>
      <section className="card" aria-labelledby="dashboard-memberships">
        <h2 id="dashboard-memberships">Memberships</h2>
        {access.workspaces.length === 0 && <p>You do not belong to a workspace yet.</p>}
        {access.workspaces.length > 0 && <ul className="membership-list">
          {access.workspaces.map((workspace, index) => <li key={workspace.org_id}>
            <strong>Workspace {index + 1}</strong>
            <RoleBadges access={{ platform_role: "", workspaces: [workspace] }} />
          </li>)}
        </ul>}
      </section>
      <section className="card" aria-labelledby="dashboard-platform">
        <h2 id="dashboard-platform">Platform role</h2>
        <RoleBadges access={{ ...access, workspaces: [] }} />
      </section>
    </div>
    {access.workspaces.filter(space => space.business_owner).map(space => <div className="workspace-access" key={space.org_id}><h2>Workspace access</h2><p className="muted">Manage the people in your workspace.</p>{me.mfa_passed === false ? <WorkspaceSecondStep auth={auth} me={me} /> : <><WorkspaceManager auth={auth} authBase={authBase} orgId={space.org_id} /><InviteManager auth={auth} authBase={authBase} scope="workspace" orgId={space.org_id} /></>}</div>)}
  </div>;
}
