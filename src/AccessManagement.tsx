import { useEffect, useState } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { workspaceRoleName } from "./roles.ts";
import { ApiError, needsSecondStep, useSecondStep } from "./SecondStep.tsx";

type Invitation = { id: string; scope: string; org_id: string; email: string; role: string; team_id?: string; expires_at: number; delivery_state: string };
type Member = { user_id: string; email?: string; name?: string; roles: string[]; team_ids?: string[]; suspended_at?: number; suspended_reason?: string };
type Team = { team_id: string; name: string; manager_id: string };
const workspaceRoles = ["manager", "caller", "closer", "client"];
/** Callers and closers sit in exactly one team, under that team's manager. */
const agentRoles = ["caller", "closer"];
const isAgent = (role: string) => agentRoles.includes(role);
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
  const [roles, setRoles] = useState(scope === "platform" ? ["tester"] : workspaceRoles) // system admin is switched off for now;
  const [items, setItems] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(roles[0]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // When email is off, the words to send the person another way (chat, phone), ready to copy.
  const [handout, setHandout] = useState("");
  const [copied, setCopied] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState("");
  useEffect(() => { if (scope === "workspace") call(auth, authBase, "GET", `/v1/orgs/${orgId}/teams`).then(result => setTeams(result.teams || []), () => setTeams([])); }, [auth, authBase, orgId, scope]);
  const needsTeam = scope === "workspace" && isAgent(role);
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
        const result = await call(auth, authBase, "POST", path, { email: invited, role, ...(needsTeam ? { team_id: teamId } : {}) });
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
    {second.prompt}<form className="staff-form" onSubmit={invite}><div className="staff-fields"><label>Email address<input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="person@example.com" /></label><label>Role<select value={role} onChange={event => setRole(event.target.value)}>{roles.map(value => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>{needsTeam && <label>Team<select required value={teamId} onChange={event => setTeamId(event.target.value)}><option value="">Choose a team</option>{teams.map(team => <option key={team.team_id} value={team.team_id}>{team.name}</option>)}</select></label>}<button className="button primary" disabled={busy || (needsTeam && !teamId)}>{busy ? "Saving…" : "Send invitation"}</button></div>{needsTeam && teams.length === 0 && <p className="muted">Callers and closers join a team. Create a team in Members first.</p>}</form>
    {message && <p className="notice" role="status">{message}</p>}
    {handout && <div className="notice" role="note"><p>{handout}</p><button type="button" className="staff-text-button" onClick={() => { void navigator.clipboard?.writeText(handout).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? "Copied" : "Copy these words"}</button></div>}
    <div><h3>Pending invitations</h3>{state === "loading" ? <p className="muted" role="status">Loading invitations…</p> : state === "error" ? <p role="alert">Invitations are unavailable. <button type="button" className="staff-text-button" onClick={() => void load()}>Retry</button></p> : items.length === 0 ? <p className="muted">No pending invitations.</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Email</th><th>Role</th><th>Delivery</th><th>Expires</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{item.email}</td><td>{roleLabel(item.role)}{item.team_id && teams.find(team => team.team_id === item.team_id) ? ` · ${teams.find(team => team.team_id === item.team_id)?.name}` : ""}</td><td>{item.delivery_state === "sent" ? "Emailed" : "Saved, not emailed"}</td><td>{new Date(item.expires_at * 1000).toLocaleString()}</td><td><button type="button" className="staff-text-button" disabled={busy} onClick={() => void revoke(item)}>Withdraw</button></td></tr>)}</tbody></table></div>}</div>
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

/** The people of one workspace and its teams. The agency owner (or platform staff) places people in teams, names each team's manager,
 * changes roles, suspends and removes; a team manager sees the callers and closers of their own teams and can suspend or restore
 * them. The server checks every change against the team tree; this only shows what each person may try. */
export function WorkspaceManager({ auth, authBase, orgId }: { auth: Auth; authBase: string; orgId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [you, setYou] = useState<{ owner: boolean; manager: boolean; staff: boolean }>({ owner: false, manager: false, staff: false });
  const [roles, setRoles] = useState(workspaceRoles);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [editing, setEditing] = useState("");
  const [role, setRole] = useState("caller");
  const [teamId, setTeamId] = useState("");
  const [newTeam, setNewTeam] = useState("");
  const [newManager, setNewManager] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => {
    try {
      const result = await call(auth, authBase, "GET", `/v1/orgs/${orgId}/members`);
      setMembers(result.members); setTeams(result.teams || []); if (result.you) setYou(result.you); setState("ready");
    } catch { setState("error"); }
  };
  useEffect(() => { void load(); }, [auth, authBase, orgId]);
  useEffect(() => { call(auth, authBase, "GET", `/v1/orgs/${orgId}/roles`).then(result => setRoles([...new Set<string>(result.roles)]), () => setMessage("Custom roles could not be loaded. Standard roles remain available.")); }, [auth, authBase, orgId]);
  const runs = (personId: string) => teams.filter(team => team.manager_id === personId);
  const teamName = (id?: string) => teams.find(team => team.team_id === id)?.name || "";
  const managers = members.filter(person => person.roles.includes("manager") && !person.suspended_at);
  const nameOf = (id: string) => { const person = members.find(entry => entry.user_id === id); return person ? person.name || person.email || "Member" : ""; };
  const isOwnerRow = (person: Member) => person.roles.some(value => value === "owner" || value === "solo");
  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true); setMessage("");
    try { await work(); await load(); setMessage(done); }
    catch (error) { setMessage(error instanceof Error ? error.message : "That change could not be made."); }
    setBusy(false);
  };
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    return act(async () => { await call(auth, authBase, "PUT", `/v1/orgs/${orgId}/members/${editing}`, { roles: [role], team_ids: isAgent(role) ? [teamId] : [] }); setEditing(""); }, "Member saved.");
  };
  const suspend = (person: Member) => {
    if (person.suspended_at) return act(() => call(auth, authBase, "POST", `/v1/orgs/${orgId}/members/${person.user_id}/restore`), `${nameOf(person.user_id)} can work again.`);
    const reason = prompt(`Suspend ${nameOf(person.user_id)}? They keep their place and history but cannot open the workspace. Reason (optional):`, "");
    if (reason === null) return Promise.resolve();
    return act(() => call(auth, authBase, "POST", `/v1/orgs/${orgId}/members/${person.user_id}/suspend`, { reason }), `${nameOf(person.user_id)} is suspended.`);
  };
  const remove = (person: Member) => {
    if (!confirm(`Remove ${nameOf(person.user_id)} from this workspace?`)) return Promise.resolve();
    return act(() => call(auth, authBase, "DELETE", `/v1/orgs/${orgId}/members/${person.user_id}`), `${nameOf(person.user_id)} was removed.`);
  };
  const addTeam = (event: React.FormEvent) => {
    event.preventDefault();
    return act(async () => { await call(auth, authBase, "PUT", `/v1/orgs/${orgId}/teams/${crypto.randomUUID()}`, { name: newTeam.trim(), manager_id: newManager }); setNewTeam(""); setNewManager(""); }, "Team created.");
  };
  const setManager = (team: Team, managerId: string) => act(() => call(auth, authBase, "PUT", `/v1/orgs/${orgId}/teams/${team.team_id}`, { name: team.name, manager_id: managerId }), managerId ? `${nameOf(managerId)} now runs ${team.name}.` : `${team.name} has no manager now.`);
  const removeTeam = (team: Team) => {
    if (!confirm(`Remove the team ${team.name}?`)) return Promise.resolve();
    return act(() => call(auth, authBase, "DELETE", `/v1/orgs/${orgId}/teams/${team.team_id}`), `${team.name} was removed.`);
  };
  const leads = you.owner || you.staff;
  const ownTeams = teams.filter(team => leads || team.manager_id === members.find(person => person.roles.includes("manager"))?.user_id);
  return <section className="admin-manage card">
    <div><span className="eyebrow">Workspace access</span><h2>{leads ? "Teams and members" : "Your team"}</h2><p className="muted">{leads ? "Each team has one manager. Callers and closers sit in one team, under its manager. The owner role is permanent." : "The callers and closers of the teams you run. You can suspend or restore them; the agency owner changes roles and teams."}</p></div>
    {state === "loading" ? <p role="status">Loading members…</p> : state === "error" ? <p role="alert">Members are unavailable. <button type="button" className="staff-text-button" onClick={() => void load()}>Retry</button></p> : <>
      {(leads || teams.length > 0) && <div><h3>Teams</h3>{teams.length === 0 ? <p className="muted">No teams yet. Create one, then invite callers and closers into it.</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Team</th><th>Manager</th><th>People</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{(leads ? teams : ownTeams).map(team => <tr key={team.team_id}><td>{team.name}</td><td>{leads ? <select aria-label={`Manager of ${team.name}`} value={team.manager_id} disabled={busy} onChange={event => void setManager(team, event.target.value)}><option value="">No manager</option>{managers.map(person => <option key={person.user_id} value={person.user_id}>{person.name || person.email}</option>)}</select> : nameOf(team.manager_id) || "No manager"}</td><td>{members.filter(person => person.team_ids?.[0] === team.team_id).length}</td><td>{leads && <button type="button" className="staff-text-button" disabled={busy} onClick={() => void removeTeam(team)}>Remove</button>}</td></tr>)}</tbody></table></div>}
        {leads && <form className="staff-form" onSubmit={addTeam}><div className="staff-fields"><label>New team<input required maxLength={100} value={newTeam} onChange={event => setNewTeam(event.target.value)} placeholder="Tampa callers" /></label><label>Manager<select value={newManager} onChange={event => setNewManager(event.target.value)}><option value="">Choose later</option>{managers.map(person => <option key={person.user_id} value={person.user_id}>{person.name || person.email}</option>)}</select></label><button className="button primary" disabled={busy || !newTeam.trim()}>Create team</button></div>{managers.length === 0 && <p className="muted">Invite someone as Team manager to give a team its manager.</p>}</form>}
      </div>}
      <div><h3>Members</h3><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Person</th><th>Role</th><th>Team</th><th>Status</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{members.map(person => <tr key={person.user_id}>
        <td>{person.name || person.email || "Account"}<small className="admin-member-email">{person.email}</small></td>
        <td>{person.roles.map(roleLabel).join(", ")}</td>
        <td>{person.roles.includes("manager") ? (runs(person.user_id).map(team => team.name).join(", ") || "Runs no team yet") : teamName(person.team_ids?.[0]) || "—"}</td>
        <td>{person.suspended_at ? <span title={person.suspended_reason || ""}>Suspended</span> : "Active"}</td>
        <td>{!isOwnerRow(person) && <span className="admin-row-actions">
          {leads && <button type="button" className="staff-text-button" disabled={busy} onClick={() => { setEditing(person.user_id); setRole(person.roles[0] || "caller"); setTeamId(person.team_ids?.[0] || ""); setMessage(""); }}>Change role or team</button>}
          {(leads || (you.manager && isAgent(person.roles[0] || ""))) && <button type="button" className="staff-text-button" disabled={busy} onClick={() => void suspend(person)}>{person.suspended_at ? "Restore" : "Suspend"}</button>}
          {leads && <button type="button" className="staff-text-button" disabled={busy} onClick={() => void remove(person)}>Remove</button>}
        </span>}</td>
      </tr>)}</tbody></table></div></div>
    </>}
    {editing && <form className="staff-form" onSubmit={save}><div className="staff-fields">
      <label>Role for {nameOf(editing)}<select value={role} onChange={event => setRole(event.target.value)}>{roles.map(value => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>
      {isAgent(role) && <label>Team<select required value={teamId} onChange={event => setTeamId(event.target.value)}><option value="">Choose a team</option>{teams.map(team => <option key={team.team_id} value={team.team_id}>{team.name}</option>)}</select></label>}
      <button className="button primary" disabled={busy || (isAgent(role) && !teamId)}>{busy ? "Saving…" : "Save"}</button><button type="button" className="button raised" onClick={() => setEditing("")}>Cancel</button>
    </div></form>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
