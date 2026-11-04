import { useEffect, useState } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { Link } from "./nav.tsx";
import { RoleBadges, type Access } from "./RoleBadges.tsx";

type StaffMember = { name: string; email?: string; role: string };
const roleNames: Record<string, string> = { owner: "Owner", cofounder: "Cofounder", system_admin: "System admin", tester: "Tester" };

const staffRoles = new Set(["owner", "cofounder", "system_admin"]);

function StaffDashboard({ access, auth, authBase, me }: { access: Access; auth: Auth; authBase: string; me: Me }) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "verify">("loading");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("system_admin");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const canManage = access.platform_role === "owner" || access.platform_role === "cofounder";
  const request = async (method: string, path: string, body?: object) => {
    const token = await auth.accessToken();
    if (!token) throw new Error("Sign in again to continue.");
    const response = await fetch(`${authBase}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error("A verified second step and the required staff role are needed.");
      const problem = await response.json().catch(() => null) as { error?: string } | null;
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
  useEffect(() => { void load(); }, [authBase, auth, access.platform_role]);
  const assign = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      await request("POST", "/v1/admin/staff", { email: email.trim(), role });
      setEmail("");
      setMessage(role ? "Staff role saved." : "Staff role removed.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save the role."); }
    setBusy(false);
  };
  const setup = async () => {
    setMessage(""); setBusy(true);
    try { setSecret((await auth.setupMfa()).secret); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not start authenticator setup."); }
    setBusy(false);
  };
  const confirm = async (event: React.FormEvent) => {
    event.preventDefault(); setMessage(""); setBusy(true);
    try {
      if (secret) setRecovery((await auth.confirmMfa(code)).recovery_codes);
      else await auth.verifyMfa(code);
      setCode(""); setSecret("");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "That code could not be confirmed."); }
    setBusy(false);
  };
  return <section className="card staff-dashboard" aria-labelledby="dashboard-administration">
    <div className="staff-heading"><div><span className="eyebrow">Platform administration</span><h2 id="dashboard-administration">Staff dashboard</h2><p className="muted">Your {access.platform_label || roleNames[access.platform_role]} access is active.</p></div><button type="button" className="button" onClick={() => void load()} disabled={status === "loading"}>Refresh</button></div>
    {status === "loading" && <p role="status">Loading staff…</p>}
    {status === "verify" && <div className="staff-verify"><h3>Confirm your identity</h3><p className="muted">Staff access requires an authenticator code.</p>{!me.mfa_enrolled && !secret && <button type="button" className="button" onClick={() => void setup()} disabled={busy}>Set up authenticator</button>}{secret && <p>Enter this setup key in your authenticator app: <code>{secret}</code></p>}{(me.mfa_enrolled || secret) && <form onSubmit={confirm}><label>Six digit code<input inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={event => setCode(event.target.value)} /></label><button className="button" disabled={busy}>Confirm code</button></form>}{message && <p role="alert">{message}</p>}</div>}
    {recovery.length > 0 && <div className="staff-recovery" role="status"><strong>Save these recovery codes now. They are shown once.</strong><pre>{recovery.join("\n")}</pre><button type="button" onClick={() => setRecovery([])}>I saved them</button></div>}
    {status === "error" && <p role="alert">Staff information is unavailable right now. Try again.</p>}
    {status === "ready" && <><div className="staff-stats"><div><strong>{staff.filter(person => person.role === "system_admin").length}</strong><span>System admins</span></div><div><strong>{staff.filter(person => person.role === "tester").length}</strong><span>Testers</span></div><div><strong>{staff.filter(person => person.role === "owner" || person.role === "cofounder").length}</strong><span>Founders</span></div></div>
      <h3>Platform team</h3><ul className="staff-list">{staff.map((person, index) => <li key={person.email || `${person.role}-${index}`}><span><strong>{person.name || person.email}</strong>{person.email && <small>{person.email}</small>}</span><span className="staff-role">{roleNames[person.role] || person.role}</span></li>)}</ul>
      {canManage && <form className="staff-form" onSubmit={assign}><h3>Manage staff access</h3><p className="muted">The person must have signed in to Caller Whale before you assign a role.</p><div className="staff-fields"><label>Account email<input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="person@example.com" /></label><label>Role<select value={role} onChange={event => setRole(event.target.value)}><option value="system_admin">System admin</option><option value="tester">Tester</option><option value="">Remove role</option></select></label><button className="button" disabled={busy}>{busy ? "Saving…" : "Save role"}</button></div>{message && <p role="status">{message}</p>}</form>}
    </>}
  </section>;
}

export function Dashboard({ me, auth, authBase }: { me: Me | null | undefined; auth: Auth; authBase: string }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

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
  }, [me?.id, auth, authBase]);

  if (!me) return <div className="form-wrap"><p className="muted">Loading your dashboard…</p></div>;
  const staff = access && staffRoles.has(access.platform_role);
  return <div className="dashboard-page">
    <header className="page-head">
      <span className="eyebrow">Your Caller Whale account</span>
      <h1>{staff ? "Administrative dashboard" : "Your dashboard"}</h1>
      <p className="lead">Your account, platform role and workspace memberships in one place.</p>
    </header>
    <div className="dashboard-panels">
      <section className="card" aria-labelledby="dashboard-account">
        <h2 id="dashboard-account">Account</h2>
        <p><strong>{me.name || me.email}</strong><br /><span className="muted">{me.email}</span></p>
        <Link to="/account">Your profile →</Link>
      </section>
      <section className="card" aria-labelledby="dashboard-memberships">
        <h2 id="dashboard-memberships">Memberships</h2>
        {status === "loading" && <p role="status">Checking your memberships…</p>}
        {status === "unavailable" && <p role="status">Membership information is unavailable right now. Try again later.</p>}
        {status === "ready" && access?.workspaces.length === 0 && <p>You do not belong to a workspace yet.</p>}
        {status === "ready" && access && access.workspaces.length > 0 && <ul className="membership-list">
          {access.workspaces.map((workspace, index) => <li key={workspace.org_id}>
            <strong>Workspace {index + 1}</strong>
            <RoleBadges access={{ platform_role: "", workspaces: [workspace] }} />
          </li>)}
        </ul>}
      </section>
      {status === "ready" && access && <section className="card" aria-labelledby="dashboard-platform">
        <h2 id="dashboard-platform">Platform role</h2>
        <RoleBadges access={{ ...access, workspaces: [] }} />
      </section>}
      {staff && <StaffDashboard access={access} auth={auth} authBase={authBase} me={me} />}
    </div>
  </div>;
}
