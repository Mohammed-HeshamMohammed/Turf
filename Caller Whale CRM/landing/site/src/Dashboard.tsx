import { useEffect, useState } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { Link } from "./nav.tsx";
import { RoleBadges, type Access } from "./RoleBadges.tsx";

type StaffMember = { name: string; email?: string; role: string };
const roleNames: Record<string, string> = { owner: "Owner", cofounder: "Cofounder", system_admin: "System admin", tester: "Tester" };

const staffRoles = new Set(["owner", "cofounder", "system_admin"]);

function StaffDashboard({ access, auth, authBase, me }: { access: Access; auth: Auth; authBase: string; me: Me }) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "verify">(me.mfa_passed === false ? "verify" : "loading");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("system_admin");
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
    try { setSetupDetails(await auth.setupMfa()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not start authenticator setup."); }
    setBusy(false);
  };
  const confirm = async (event: React.FormEvent) => {
    event.preventDefault(); setMessage(""); setBusy(true);
    try {
      if (setupDetails) setRecovery((await auth.confirmMfa(code.trim())).recovery_codes);
      else await auth.verifyMfa(code.trim());
      setCode(""); setSetupDetails(null); setCopyMessage("");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "That code could not be confirmed."); }
    setBusy(false);
  };
  return <section className="card staff-dashboard" aria-labelledby="dashboard-administration">
    <div className="staff-heading"><div><span className="eyebrow">Platform administration</span><h2 id="dashboard-administration">Staff dashboard</h2><p className="muted">Your {access.platform_label || roleNames[access.platform_role]} access is active.</p></div><button type="button" className="button" onClick={() => void load()} disabled={status === "loading"}>Refresh</button></div>
    {status === "loading" && <p role="status">Loading staff…</p>}
    {status === "verify" && <div className="staff-verify">
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
        <div className="staff-code-row"><input id="staff-auth-code" inputMode={useRecoveryCode && !setupDetails ? "text" : "numeric"} autoComplete="one-time-code" required minLength={setupDetails || !useRecoveryCode ? 6 : undefined} maxLength={setupDetails || !useRecoveryCode ? 6 : undefined} pattern={setupDetails || !useRecoveryCode ? "[0-9]{6}" : undefined} placeholder={useRecoveryCode && !setupDetails ? "Enter a recovery code" : "000000"} value={code} onChange={event => setCode(setupDetails || !useRecoveryCode ? event.target.value.replace(/\D/g, "").slice(0, 6) : event.target.value)} /><button className="button primary" disabled={busy}>{busy ? "Checking…" : setupDetails ? "Finish setup" : "Verify and continue"}</button></div>
        {!setupDetails && <button type="button" className="staff-text-button" onClick={() => { setUseRecoveryCode(value => !value); setCode(""); }}>{useRecoveryCode ? "Use authenticator code instead" : "Use a recovery code instead"}</button>}
      </form>}
      {copyMessage && <p className="fine" role="status">{copyMessage}</p>}
      {message && <p className="notice bad" role="alert">{message}</p>}
    </div>}
    {recovery.length > 0 && <div className="staff-recovery" role="status"><span className="eyebrow">One-time backup</span><h3>Save your recovery codes</h3><p>These codes can restore staff access if you lose your authenticator. Each code works once. They will not be shown again after you leave this page.</p><ol>{recovery.map(value => <li key={value}><code>{value}</code></li>)}</ol><div className="staff-recovery-actions"><button type="button" className="button raised" onClick={() => void copy(recovery.join("\n"), "Recovery codes")}>Copy codes</button><button type="button" className="button raised" onClick={downloadRecovery}>Download text file</button></div>{copyMessage && <p className="fine" role="status">{copyMessage}</p>}<button type="button" className="button primary" onClick={() => { setRecovery([]); setCopyMessage(""); }}>I saved my codes</button></div>}
    {status === "error" && <p role="alert">Staff information is unavailable right now. Try again.</p>}
    {status === "ready" && recovery.length === 0 && <><div className="staff-stats"><div><strong>{staff.filter(person => person.role === "system_admin").length}</strong><span>System admins</span></div><div><strong>{staff.filter(person => person.role === "tester").length}</strong><span>Testers</span></div><div><strong>{staff.filter(person => person.role === "owner" || person.role === "cofounder").length}</strong><span>Founders</span></div></div>
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
