import { useEffect, useState } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { workspaceRoleName } from "./roles.ts";
import { ApiError, needsSecondStep, useSecondStep } from "./SecondStep.tsx";

type Invitation = { id: string; scope: string; org_id: string; email: string; role: string; expires_at: number; delivery_state: string };
type Member = { user_id: string; email?: string; name?: string; roles: string[] };
const workspaceRoles = ["manager", "caller", "closer", "researcher", "client"];
const roleLabel = (role: string) => workspaceRoleName(role);

async function call(auth: Auth, base: string, method: string, path: string, body?: object) {
  const token = await auth.accessToken();
  if (!token) throw new Error("Sign in again to continue.");
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(result?.error || "The request could not be completed.", result?.code || "");
  return result;
}

export function InviteManager({ auth, authBase, scope, orgId = "" }: { auth: Auth; authBase: string; scope: "platform" | "workspace"; orgId?: string }) {
  const path = scope === "platform" ? "/v1/admin/invitations" : `/v1/orgs/${orgId}/invitations`;
  const [roles, setRoles] = useState(scope === "platform" ? ["system_admin", "tester"] : workspaceRoles);
  const [items, setItems] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(roles[0]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // When email is off, the words to send the person another way (chat, phone), ready to copy.
  const [handout, setHandout] = useState("");
  const [copied, setCopied] = useState(false);
  const load = async () => { try { setItems((await call(auth, authBase, "GET", path)).invitations); setState("ready"); } catch { setState("error"); } };
  useEffect(() => { void load(); }, [auth, authBase, path]);
  useEffect(() => { if (scope === "workspace") call(auth, authBase, "GET", `/v1/orgs/${orgId}/roles`).then(result => setRoles([...new Set<string>(result.roles)]), () => setMessage("Custom roles could not be loaded. The standard roles are available.")); }, [auth, authBase, orgId, scope]);
  // Platform staff invitations are for the owner and cofounders, and need a second step done just now: the code box appears here.
  const second = useSecondStep(auth, "Inviting or withdrawing platform staff needs a code entered just now.");
  const invite = (event: React.FormEvent) => {
    event.preventDefault();
    return second.guard(async () => {
      setBusy(true); setMessage(""); setHandout(""); setCopied(false);
      try {
        const invited = email.trim();
        const result = await call(auth, authBase, "POST", path, { email: invited, role });
        setEmail(""); await load();
        if (result.delivery_state === "sent") setMessage("Invitation emailed.");
        else {
          setMessage("Invitation saved, but it was not emailed: email sending is not set up yet. Send the person these words another way:");
          const until = result.expires_at ? new Date(result.expires_at * 1000).toLocaleString() : "";
          setHandout(`You're invited to Caller Whale as ${roleLabel(role)}. Sign in at ${window.location.origin} with ${invited}, open your dashboard and press "Accept invitation".${until ? ` The invitation works until ${until}.` : ""}`);
        }
      } catch (error) {
        if (needsSecondStep(error)) { setBusy(false); throw error; }
        setMessage(error instanceof Error ? error.message : "Could not invite this person.");
      }
      setBusy(false);
    });
  };
  const revoke = (item: Invitation) => {
    if (!confirm(`Withdraw the invitation for ${item.email}?`)) return Promise.resolve();
    return second.guard(async () => {
      setBusy(true); setMessage("");
      try { await call(auth, authBase, "DELETE", `/v1/invitations/${item.id}`); await load(); setMessage("Invitation withdrawn."); }
      catch (error) {
        if (needsSecondStep(error)) { setBusy(false); throw error; }
        setMessage(error instanceof Error ? error.message : "Could not withdraw the invitation.");
      }
      setBusy(false);
    });
  };
  return <section className="admin-manage card" aria-label={`${scope} invitations`}>
    <div><span className="eyebrow">Invitation</span><h2>Invite {scope === "platform" ? "platform staff" : "workspace members"}</h2><p className="muted">Access starts only after the recipient signs in with this email, confirms it, and accepts the invitation. {scope === "platform" ? "Invitations expire one hour after they are created." : "Invitations expire 72 hours after they are created."}</p></div>
    {second.prompt}<form className="staff-form" onSubmit={invite}><div className="staff-fields"><label>Email address<input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="person@example.com" /></label><label>Role<select value={role} onChange={event => setRole(event.target.value)}>{roles.map(value => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Send invitation"}</button></div></form>
    {message && <p className="notice" role="status">{message}</p>}
    {handout && <div className="notice" role="note"><p>{handout}</p><button type="button" className="staff-text-button" onClick={() => { void navigator.clipboard?.writeText(handout).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? "Copied" : "Copy these words"}</button></div>}
    <div><h3>Pending invitations</h3>{state === "loading" ? <p className="muted" role="status">Loading invitations…</p> : state === "error" ? <p role="alert">Invitations are unavailable. <button type="button" className="staff-text-button" onClick={() => void load()}>Retry</button></p> : items.length === 0 ? <p className="muted">No pending invitations.</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Email</th><th>Role</th><th>Delivery</th><th>Expires</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{item.email}</td><td>{roleLabel(item.role)}</td><td>{item.delivery_state === "sent" ? "Emailed" : "Saved, not emailed"}</td><td>{new Date(item.expires_at * 1000).toLocaleString()}</td><td><button type="button" className="staff-text-button" disabled={busy} onClick={() => void revoke(item)}>Withdraw</button></td></tr>)}</tbody></table></div>}</div>
  </section>;
}

export function PendingInvitations({ auth, authBase }: { auth: Auth; authBase: string }) {
  const [items, setItems] = useState<Invitation[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { call(auth, authBase, "GET", "/v1/me/invitations").then(result => setItems(result.invitations), () => setError("Invitations could not be loaded.")); }, [auth, authBase]);
  if (!items.length && !error) return null;
  const accept = async (item: Invitation) => {
    setBusy(true); setError("");
    try { await call(auth, authBase, "POST", `/v1/me/invitations/${item.id}/accept`); location.reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not accept the invitation."); setBusy(false); }
  };
  return <section className="card admin-pending" aria-label="Your invitations"><h2>Your invitations</h2>{items.map(item => <div className="admin-invite-row" key={item.id}><span><strong>{item.scope === "platform" ? "Caller Whale platform" : "Workspace"}</strong><small>{roleLabel(item.role)} · invited at {item.email} · expires {new Date(item.expires_at * 1000).toLocaleString()}</small></span><button type="button" className="button primary" disabled={busy} onClick={() => void accept(item)}>Accept invitation</button></div>)}{error && <p className="notice bad" role="alert">{error}</p>}</section>;
}

export function WorkspaceSecondStep({ auth, me }: { auth: Auth; me: Me }) {
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!setup) return; let active = true; import("qrcode").then(({ toDataURL }) => toDataURL(setup.otpauth_url, { width: 224, margin: 2 })).then(value => { if (active) setQr(value); }, () => { if (active) setMessage("QR code unavailable. Enter the setup key in your authenticator app."); }); return () => { active = false; }; }, [setup]);
  const begin = async () => { setBusy(true); setMessage(""); try { setSetup(await auth.setupMfa()); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not start setup."); } setBusy(false); };
  const confirmCode = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); setMessage(""); try { if (setup) { setRecovery((await auth.confirmMfa(code)).recovery_codes); setSetup(null); } else { await auth.verifyMfa(code); location.reload(); } } catch (error) { setMessage(error instanceof Error ? error.message : "That code did not work."); } setBusy(false); };
  return <section className="staff-verify" aria-label="Secure workspace access"><span className="eyebrow">Protect member access</span><h2>{recovery.length ? "Save your recovery codes" : setup ? "Connect your authenticator" : me.mfa_enrolled ? "Confirm it’s you" : "Set up an authenticator"}</h2>{recovery.length ? <><p>Each code works once. Save them somewhere private before continuing.</p><ol>{recovery.map(value => <li key={value}><code>{value}</code></li>)}</ol><button type="button" className="button primary" onClick={() => location.reload()}>I saved my codes</button></> : <>{!me.mfa_enrolled && !setup && <button type="button" className="button primary" disabled={busy} onClick={() => void begin()}>Set up authenticator</button>}{setup && <div className="staff-setup"><div className="staff-qr">{qr ? <img src={qr} width="224" height="224" alt="Scan to add Caller Whale to your authenticator" /> : "Preparing QR code…"}</div><div className="staff-setup-instructions"><p>Scan the QR code, or enter this setup key in your app:</p><code>{setup.secret}</code></div></div>}{(me.mfa_enrolled || setup) && <form className="staff-code-form" onSubmit={confirmCode}><label>Six-digit code<input inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" /></label><button className="button primary" disabled={busy}>{busy ? "Checking…" : "Verify and continue"}</button></form>}</>}{message && <p className="notice bad" role="alert">{message}</p>}</section>;
}

export function WorkspaceManager({ auth, authBase, orgId }: { auth: Auth; authBase: string; orgId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState(workspaceRoles);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [editing, setEditing] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>(["caller"]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => { try { setMembers((await call(auth, authBase, "GET", `/v1/orgs/${orgId}/members`)).members); setState("ready"); } catch { setState("error"); } };
  useEffect(() => { void load(); }, [auth, authBase, orgId]);
  useEffect(() => { call(auth, authBase, "GET", `/v1/orgs/${orgId}/roles`).then(result => setRoles([...new Set<string>(result.roles)]), () => setMessage("Custom roles could not be loaded. Standard roles remain available.")); }, [auth, authBase, orgId]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage("");
    try { await call(auth, authBase, "PUT", `/v1/orgs/${orgId}/members/${editing}`, { roles: selectedRoles }); await load(); setEditing(""); setMessage("Member roles saved."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not change the member role."); }
    setBusy(false);
  };
  return <section className="admin-manage card"><div><span className="eyebrow">Workspace access</span><h2>Members</h2><p className="muted">Manage roles for this workspace. The owner role is permanent.</p></div>{state === "loading" ? <p role="status">Loading members…</p> : state === "error" ? <p role="alert">Members are unavailable. <button type="button" className="staff-text-button" onClick={() => void load()}>Retry</button></p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Person</th><th>Role</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{members.map(person => <tr key={person.user_id}><td>{person.name || person.email || "Account"}<small className="admin-member-email">{person.email}</small></td><td>{person.roles.map(roleLabel).join(", ")}</td><td>{!person.roles.some(value => value === "owner" || value === "solo") && <button type="button" className="staff-text-button" onClick={() => { setEditing(person.user_id); setSelectedRoles(person.roles); setMessage(""); }}>Change roles</button>}</td></tr>)}</tbody></table></div>}{editing && <form className="staff-form" onSubmit={save}><fieldset className="admin-role-options"><legend>Member roles</legend>{roles.map(value => <label key={value}><input type="checkbox" checked={selectedRoles.includes(value)} onChange={event => setSelectedRoles(current => event.target.checked ? [...current, value] : current.filter(role => role !== value))} />{roleLabel(value)}</label>)}</fieldset><div className="staff-fields"><button className="button primary" disabled={busy || selectedRoles.length === 0}>{busy ? "Saving…" : "Save roles"}</button><button type="button" className="button raised" onClick={() => setEditing("")}>Cancel</button></div></form>}{message && <p className="notice" role="status">{message}</p>}</section>;
}
