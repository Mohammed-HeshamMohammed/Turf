import { useEffect, useState } from "react";
import type { Auth, Me } from "@callerwhale/auth-client";
import { workspaceRoleName } from "./roles.ts";
import { ApiError, needsSecondStep, useSecondStep } from "./SecondStep.tsx";

type Invitation = { id: string; scope: string; org_id: string; email: string; role: string; team_id?: string; expires_at: number; created_at?: number; delivery_state: string; org_name?: string; owner_name?: string; inviter_name?: string; status?: string; status_reason?: string; resends_left?: number; extends_left?: number; next_resend_at?: number };
/** An invitation's state in words: waiting, blocked (with why), ended, declined or cancelled. */
const statusWords = (item: Invitation) => {
  switch (item.status) {
    case "blocked": return `Blocked: ${item.status_reason || "it cannot be accepted yet."}`;
    case "expired": return "Ended";
    case "declined": return "Declined";
    case "cancelled": return item.status_reason ? `Cancelled: ${item.status_reason}` : "Cancelled";
    default: return "Waiting";
  }
};
/** How an invitation's email went: sent, failed (tried and refused), or not set up (email is switched off on this server). */
const deliveryWords = (state: string) => state === "sent" ? "Emailed" : state === "failed" ? "Email failed" : "Not emailed (email is off)";
type Member = { user_id: string; email?: string; name?: string; roles: string[]; team_ids?: string[]; suspended_at?: number; suspended_reason?: string };
type Team = { team_id: string; name: string; manager_id: string; manager_ids?: string[]; deputy_ids?: string[] };
/** A team's leads: several under the new team rules, the one manager from an older server. */
const leadsOf = (team: Team) => team.manager_ids?.length ? team.manager_ids : team.manager_id ? [team.manager_id] : [];
/** The values picked in a multiple select. */
const picked = (select: HTMLSelectElement) => [...select.selectedOptions].map(option => option.value).filter(Boolean);
const workspaceRoles = ["manager", "caller", "closer", "client"];
/** Callers and closers sit in exactly one team, under that team's manager. */
const agentRoles = ["caller", "closer", "researcher"];
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
  // A team lead can be invited with the teams they will lead; those teams get them when they accept (step 3).
  const [leadTeams, setLeadTeams] = useState<string[]>([]);
  // Seats team leads asked for when every seat was taken (D71); only the owner and admins see them.
  const [seatAsks, setSeatAsks] = useState<{ id: string; name: string; for_email: string; created_at: number }[]>([]);
  const loadAsks = () => { if (scope === "workspace") call(auth, authBase, "GET", `/v1/orgs/${orgId}/seat-requests`).then(result => setSeatAsks(result.requests || []), () => setSeatAsks([])); };
  useEffect(loadAsks, [auth, authBase, orgId, scope]);
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
        const result = await call(auth, authBase, "POST", path, { email: invited, role, ...(needsTeam ? { team_id: teamId } : {}), ...(scope === "workspace" && role === "manager" && leadTeams.length ? { lead_team_ids: leadTeams } : {}) });
        setEmail(""); setLeadTeams([]); await load();
        if (result.delivery_state === "sent") setMessage("Invitation emailed.");
        else {
          setMessage(result.delivery_state === "failed"
            ? "Invitation saved, but the email could not be sent. Send the person these words another way:"
            : "Invitation saved, but it was not emailed: email sending is not set up yet. Send the person these words another way:");
          const until = result.expires_at ? new Date(result.expires_at * 1000).toLocaleString() : "";
          const link = result.link || `${window.location.origin}/dashboard`;
          setHandout(`You're invited to Caller Whale as ${roleLabel(role)}. Open ${link} and sign in with ${invited}, then press "Accept invitation".${until ? ` The invitation works until ${until}.` : ""}`);
        }
      } catch (error) {
        if (needsSecondStep(error)) { setBusy(false); throw error; }
        setMessage(error instanceof Error ? error.message : "Could not invite this person.");
      }
      setBusy(false);
    });
  };
  // How long this agency's invitations last (1 to 30 days), set by the owner.
  const [validDays, setValidDays] = useState(7);
  useEffect(() => { if (scope === "workspace") call(auth, authBase, "GET", `/v1/orgs/${orgId}/invitation-settings`).then(result => setValidDays(result.valid_days || 7), () => undefined); }, [auth, authBase, orgId, scope]);
  const saveDays = async (days: number) => {
    setBusy(true); setMessage("");
    try { setValidDays((await call(auth, authBase, "PUT", `/v1/orgs/${orgId}/invitation-settings`, { valid_days: days })).valid_days); setMessage(`New invitations now last ${days} ${days === 1 ? "day" : "days"}.`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save how long invitations last."); }
    setBusy(false);
  };
  const again = async (item: Invitation, what: "resend" | "extend") => {
    setBusy(true); setMessage("");
    try {
      const result = await call(auth, authBase, "POST", `/v1/invitations/${item.id}/${what}`);
      await load();
      setMessage(what === "extend" ? `Extended until ${new Date(result.expires_at * 1000).toLocaleString()}.` : result.delivery_state === "sent" ? "Invitation emailed again." : "The email could not be sent. Send the person the link another way.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not change the invitation."); }
    setBusy(false);
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
    <div><span className="eyebrow">Invitation</span><h2>Invite {scope === "platform" ? "platform staff" : "workspace members"}</h2><p className="muted">Access starts only after the recipient signs in with this email, confirms it, and accepts the invitation. {scope === "platform" ? "Invitations expire one hour after they are created." : <>Invitations last <select aria-label="How long invitations last" value={validDays} disabled={busy} onChange={event => void saveDays(Number(event.target.value))}>{[1, 2, 3, 5, 7, 10, 14, 21, 30].map(days => <option key={days} value={days}>{days} {days === 1 ? "day" : "days"}</option>)}</select>. Each can be resent three times (once an hour) and extended twice.</>}</p></div>
    {second.prompt}<form className="staff-form" onSubmit={invite}><div className="staff-fields"><label>Email address<input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="person@example.com" /></label><label>Role<select value={role} onChange={event => setRole(event.target.value)}>{roles.map(value => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>{needsTeam && <label>Team<select required value={teamId} onChange={event => setTeamId(event.target.value)}><option value="">Choose a team</option>{teams.map(team => <option key={team.team_id} value={team.team_id}>{team.name}</option>)}</select></label>}<button className="button primary" disabled={busy || (needsTeam && !teamId)}>{busy ? "Saving…" : "Send invitation"}</button></div>{scope === "workspace" && role === "manager" && teams.length > 0 && <label>Teams they will lead (optional)<select multiple size={Math.min(4, Math.max(2, teams.length))} value={leadTeams} onChange={event => setLeadTeams(picked(event.currentTarget))}>{teams.map(team => <option key={team.team_id} value={team.team_id}>{team.name}</option>)}</select></label>}{needsTeam && teams.length === 0 && <p className="muted">Callers, closers and researchers join a team. Create a team in Teams and members first.</p>}</form>
    {seatAsks.length > 0 && <div className="notice" role="note"><p><strong>Team leads asked for more seats.</strong> Every seat was taken when they tried to invite. Nothing is charged until you add seats.</p><ul>{seatAsks.map(ask => <li key={ask.id}>{ask.name || "A team lead"} wanted to invite {ask.for_email} ({new Date(ask.created_at * 1000).toLocaleDateString()}) <button type="button" className="staff-text-button" onClick={() => { void call(auth, authBase, "DELETE", `/v1/orgs/${orgId}/seat-requests/${ask.id}`).then(loadAsks, loadAsks); }}>Done</button></li>)}</ul></div>}
    {message && <p className="notice" role="status">{message}</p>}
    {handout && <div className="notice" role="note"><p>{handout}</p><button type="button" className="staff-text-button" onClick={() => { void navigator.clipboard?.writeText(handout).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? "Copied" : "Copy these words"}</button></div>}
    <div><h3>Pending invitations</h3>{state === "loading" ? <p className="muted" role="status">Loading invitations…</p> : state === "error" ? <p role="alert">Invitations are unavailable. <button type="button" className="staff-text-button" onClick={() => void load()}>Retry</button></p> : items.length === 0 ? <p className="muted">No pending invitations.</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Delivery</th><th>Expires</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{items.map(item => { const open = !item.status || item.status === "pending" || item.status === "blocked" || item.status === "expired"; return <tr key={item.id}><td>{item.email}</td><td>{roleLabel(item.role)}{item.team_id && teams.find(team => team.team_id === item.team_id) ? ` · ${teams.find(team => team.team_id === item.team_id)?.name}` : ""}</td><td>{statusWords(item)}</td><td>{deliveryWords(item.delivery_state)}</td><td>{new Date(item.expires_at * 1000).toLocaleString()}</td><td>{open && <>{item.status !== "expired" && (item.resends_left ?? 0) > 0 && <button type="button" className="staff-text-button" disabled={busy || (item.next_resend_at ?? 0) * 1000 > Date.now()} title={(item.next_resend_at ?? 0) * 1000 > Date.now() ? `Can be resent after ${new Date((item.next_resend_at ?? 0) * 1000).toLocaleTimeString()}` : `${item.resends_left} resends left`} onClick={() => void again(item, "resend")}>Resend</button>}{(item.extends_left ?? 0) > 0 && <button type="button" className="staff-text-button" disabled={busy} title={`${item.extends_left} extensions left`} onClick={() => void again(item, "extend")}>Extend</button>}<button type="button" className="staff-text-button" disabled={busy} onClick={() => void revoke(item)}>Withdraw</button></>}</td></tr>; })}</tbody></table></div>}</div>
  </section>;
}

export function PendingInvitations({ auth, authBase }: { auth: Auth; authBase: string }) {
  const [items, setItems] = useState<Invitation[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // The email link opens /dashboard?invitation=<id>: say plainly why that invitation cannot be used (another address, cancelled, ended).
  const linked = new URLSearchParams(window.location.search).get("invitation") || "";
  useEffect(() => { call(auth, authBase, "GET", "/v1/me/invitations").then(result => { setItems(result.invitations); setWaiting(Boolean(result.waiting) && result.email_verified === false); }, () => setError("Invitations could not be loaded.")); }, [auth, authBase]);
  useEffect(() => { if (linked) call(auth, authBase, "GET", `/v1/me/invitations/${encodeURIComponent(linked)}`).catch(cause => setError(cause instanceof Error ? cause.message : "This invitation cannot be opened.")); }, [auth, authBase, linked]);
  if (!items.length && !error && !waiting) return null;
  const accept = async (item: Invitation) => {
    setBusy(true); setError("");
    try { await call(auth, authBase, "POST", `/v1/me/invitations/${item.id}/accept`); location.replace(`${window.location.pathname}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not accept the invitation."); setBusy(false); }
  };
  const report = async (item: Invitation) => {
    const reason = prompt("Tell Caller Whale what looks wrong with this invitation (optional):");
    if (reason === null) return;
    setBusy(true); setError(""); setNotice("");
    try { await call(auth, authBase, "POST", `/v1/me/invitations/${item.id}/report`, { reason }); setNotice("Thank you. Caller Whale staff will look at this invitation. It stays here until you accept it or it ends."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not report the invitation."); }
    setBusy(false);
  };
  const decline = async (item: Invitation) => {
    if (!confirm(`Decline the invitation from ${item.org_name || "this agency"}?`)) return;
    setBusy(true); setError(""); setNotice("");
    try { await call(auth, authBase, "POST", `/v1/me/invitations/${item.id}/decline`); setItems(items.filter(other => other.id !== item.id)); setNotice("Invitation declined."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not decline the invitation."); }
    setBusy(false);
  };
  const block = async (item: Invitation) => {
    if (!confirm(`Block ${item.org_name || "this agency"}? It will never be able to invite you again, and its invitations to you are declined. You can undo this later.`)) return;
    setBusy(true); setError(""); setNotice("");
    try { await call(auth, authBase, "POST", "/v1/me/blocked-agencies", { invitation_id: item.id }); setItems(items.filter(other => other.org_id !== item.org_id)); setNotice(`${item.org_name || "The agency"} is blocked.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not block the agency."); }
    setBusy(false);
  };
  const from = (item: Invitation) => item.scope === "platform" ? "Caller Whale platform" : item.org_name || "Workspace";
  const who = (item: Invitation) => [item.owner_name ? `owner ${item.owner_name}` : "", item.inviter_name && item.inviter_name !== item.owner_name ? `sent by ${item.inviter_name}` : ""].filter(Boolean).join(" · ");
  return <section className="card admin-pending" aria-label="Your invitations"><h2>Your invitations</h2>
    {waiting && <p className="notice" role="status">An invitation is waiting. Confirm your email to see it.</p>}
    {items.map(item => <div className={`admin-invite-row${item.id === linked ? " linked" : ""}`} key={item.id}><span><strong>{from(item)}</strong><small>{[roleLabel(item.role), who(item), `invited at ${item.email}`, item.created_at ? `sent ${new Date(item.created_at * 1000).toLocaleString()}` : "", `expires ${new Date(item.expires_at * 1000).toLocaleString()}`].filter(Boolean).join(" · ")}</small>{item.status === "blocked" && <small className="notice bad">This invitation cannot be accepted yet: {item.status_reason} Ask whoever invited you to fix it.</small>}</span><span><button type="button" className="button primary" disabled={busy || item.status === "blocked"} onClick={() => void accept(item)}>Accept invitation</button> <button type="button" className="staff-text-button" disabled={busy} onClick={() => void decline(item)}>Decline</button>{item.scope === "workspace" && <> <button type="button" className="staff-text-button" disabled={busy} onClick={() => void block(item)}>Block this agency</button></>} <button type="button" className="staff-text-button" disabled={busy} onClick={() => void report(item)}>Report this invitation</button></span></div>)}
    {notice && <p className="notice" role="status">{notice}</p>}{error && <p className="notice bad" role="alert">{error}</p>}</section>;
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
  return <section className="staff-verify" aria-label="Secure workspace access"><span className="eyebrow">Protect member access</span><h2>{recovery.length ? "Save your recovery codes" : setup ? "Connect your authenticator" : me.mfa_enrolled ? "Confirm it’s you" : "Set up an authenticator"}</h2>{!recovery.length && <p className="muted">Your members, teams and invitations open once this is done.</p>}{recovery.length ? <><p>Each code works once. Save them somewhere private before continuing.</p><ol>{recovery.map(value => <li key={value}><code>{value}</code></li>)}</ol><button type="button" className="button primary" onClick={() => location.reload()}>I saved my codes</button></> : <>{!me.mfa_enrolled && !setup && <button type="button" className="button primary" disabled={busy} onClick={() => void begin()}>Set up authenticator</button>}{setup && <div className="staff-setup"><div className="staff-qr">{qr ? <img src={qr} width="224" height="224" alt="Scan to add Caller Whale to your authenticator" /> : "Preparing QR code…"}</div><div className="staff-setup-instructions"><p>Scan the QR code, or enter this setup key in your app:</p><code>{setup.secret}</code></div></div>}{(me.mfa_enrolled || setup) && <form className="staff-code-form" onSubmit={confirmCode}><label>Six-digit code<input inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" /></label><button className="button primary" disabled={busy}>{busy ? "Checking…" : "Verify and continue"}</button></form>}</>}{message && <p className="notice bad" role="alert">{message}</p>}</section>;
}

/** The people of one workspace and its teams. The agency owner (or platform staff) places people in teams, names each team's manager,
 * changes roles, suspends and removes; a team manager sees the callers and closers of their own teams and can suspend or restore
 * them. The server checks every change against the team tree; this only shows what each person may try. */
export function WorkspaceManager({ auth, authBase, orgId }: { auth: Auth; authBase: string; orgId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [you, setYou] = useState<{ owner: boolean; manager: boolean; staff: boolean; admin?: boolean }>({ owner: false, manager: false, staff: false });
  // The switches on for this workspace: "teams_v2" is the new team rules (several leads, deputies, admins, agents in several teams).
  const [features, setFeatures] = useState<string[]>([]);
  const teamsV2 = features.includes("teams_v2");
  const [roleList, setRoleList] = useState<string[]>([]);
  const [teamList, setTeamList] = useState<string[]>([]);
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
      setMembers(result.members); setTeams(result.teams || []); setFeatures(result.features || []); if (result.you) setYou(result.you); setState("ready");
    } catch { setState("error"); }
  };
  useEffect(() => { void load(); }, [auth, authBase, orgId]);
  useEffect(() => { call(auth, authBase, "GET", `/v1/orgs/${orgId}/roles`).then(result => setRoles([...new Set<string>(result.roles)]), () => setMessage("Custom roles could not be loaded. Standard roles remain available.")); }, [auth, authBase, orgId]);
  const runs = (personId: string) => teams.filter(team => leadsOf(team).includes(personId));
  const teamsOf = (person: Member) => (person.team_ids || []).map(teamName).filter(Boolean).join(", ");
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
    // Under the new team rules a person can hold several roles and an agent can be in up to five teams (D97, D98).
    const chosenRoles = teamsV2 && roleList.length ? roleList : [role];
    const agent = chosenRoles.some(isAgent);
    const chosenTeams = teamsV2 ? teamList : teamId ? [teamId] : [];
    return act(async () => { await call(auth, authBase, "PUT", `/v1/orgs/${orgId}/members/${editing}`, { roles: chosenRoles, team_ids: agent ? chosenTeams : [] }); setEditing(""); }, "Member saved.");
  };
  const setLeads = (team: Team, ids: string[]) => act(() => call(auth, authBase, "PUT", `/v1/orgs/${orgId}/teams/${team.team_id}`, { name: team.name, manager_ids: ids }), ids.length ? `${team.name} is led by ${ids.map(nameOf).join(", ")}.` : `${team.name} has no team lead now.`);
  const setDeputies = (team: Team, ids: string[]) => act(() => call(auth, authBase, "PUT", `/v1/orgs/${orgId}/teams/${team.team_id}/deputies`, { deputy_ids: ids }), ids.length ? `Deputy leads of ${team.name}: ${ids.map(nameOf).join(", ")}.` : `${team.name} has no deputy lead now.`);
  const flip = () => act(() => call(auth, authBase, "PUT", `/v1/admin/workspaces/${orgId}/features/teams_v2`, { on: !teamsV2 }), teamsV2 ? "The new team rules are off for this agency." : "The new team rules are on for this agency.");
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
  const setManager = (team: Team, managerId: string) => act(() => call(auth, authBase, "PUT", `/v1/orgs/${orgId}/teams/${team.team_id}`, { name: team.name, manager_id: managerId }), managerId ? `${nameOf(managerId)} now leads ${team.name}.` : `${team.name} has no team lead now.`);
  const removeTeam = (team: Team) => {
    if (!confirm(`Remove the team ${team.name}?`)) return Promise.resolve();
    return act(() => call(auth, authBase, "DELETE", `/v1/orgs/${orgId}/teams/${team.team_id}`), `${team.name} was removed.`);
  };
  const leads = you.owner || you.staff;
  const ownTeams = teams.filter(team => leads || members.some(person => person.roles.includes("manager") && leadsOf(team).includes(person.user_id)));
  const workers = members.filter(person => !person.suspended_at && !(person.roles.length === 1 && person.roles[0] === "client"));
  return <section className="admin-manage card">
    <div><span className="eyebrow">Workspace access</span><h2>{leads ? "Teams and members" : "Your team"}</h2><p className="muted">{leads ? (teamsV2 ? "A team has no lead, one, or several equal leads, and deputy leads who help them. Callers, closers and researchers can be in up to five teams. The owner role is permanent." : "Each team has one team lead. Callers and closers sit in one team, under its lead. The owner role is permanent.") : "The callers, closers and researchers of the teams you lead. You can suspend or restore them; the agency owner changes roles and teams."}</p>
      {you.staff && <p className="notice" role="note">New team rules for this agency (staff only): <strong>{teamsV2 ? "on" : "off"}</strong>. <button type="button" className="staff-text-button" disabled={busy} onClick={() => void flip()}>{teamsV2 ? "Turn off" : "Turn on"}</button></p>}</div>
    {state === "loading" ? <p role="status">Loading members…</p> : state === "error" ? <p role="alert">Members are unavailable. <button type="button" className="staff-text-button" onClick={() => void load()}>Retry</button></p> : <>
      {(leads || teams.length > 0) && <div><h3>Teams</h3>{teams.length === 0 ? <p className="muted">No teams yet. Create one, then invite callers and closers into it.</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Team</th><th>{teamsV2 ? "Team leads" : "Team lead"}</th>{teamsV2 && <th>Deputy leads</th>}<th>People</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{(leads ? teams : ownTeams).map(team => <tr key={team.team_id}><td>{team.name}</td><td>{leads && teamsV2 ? <select multiple size={Math.min(4, Math.max(2, managers.length))} aria-label={`Team leads of ${team.name}`} value={leadsOf(team)} disabled={busy} onChange={event => void setLeads(team, picked(event.currentTarget))}>{managers.map(person => <option key={person.user_id} value={person.user_id}>{person.name || person.email}</option>)}</select> : leads ? <select aria-label={`Team lead of ${team.name}`} value={team.manager_id} disabled={busy} onChange={event => void setManager(team, event.target.value)}><option value="">No team lead</option>{managers.map(person => <option key={person.user_id} value={person.user_id}>{person.name || person.email}</option>)}</select> : leadsOf(team).map(nameOf).join(", ") || "No team lead"}</td>{teamsV2 && <td>{leads || you.manager ? <select multiple size={Math.min(4, Math.max(2, workers.length))} aria-label={`Deputy leads of ${team.name}`} value={team.deputy_ids || []} disabled={busy} onChange={event => void setDeputies(team, picked(event.currentTarget))}>{workers.filter(person => !leadsOf(team).includes(person.user_id)).map(person => <option key={person.user_id} value={person.user_id}>{person.name || person.email}</option>)}</select> : (team.deputy_ids || []).map(nameOf).join(", ") || "—"}</td>}<td>{members.filter(person => person.team_ids?.includes(team.team_id)).length}</td><td>{leads && <button type="button" className="staff-text-button" disabled={busy} onClick={() => void removeTeam(team)}>Remove</button>}</td></tr>)}</tbody></table></div>}
        {leads && <form className="staff-form" onSubmit={addTeam}><div className="staff-fields"><label>New team<input required maxLength={100} value={newTeam} onChange={event => setNewTeam(event.target.value)} placeholder="Tampa callers" /></label><label>Team lead<select value={newManager} onChange={event => setNewManager(event.target.value)}><option value="">Choose later</option>{managers.map(person => <option key={person.user_id} value={person.user_id}>{person.name || person.email}</option>)}</select></label><button className="button primary" disabled={busy || !newTeam.trim()}>Create team</button></div>{managers.length === 0 && <p className="muted">A team can start without a lead. Invite someone as Team lead to give it one.</p>}</form>}
      </div>}
      <div><h3>Members</h3><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Person</th><th>Role</th><th>Team</th><th>Status</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{members.map(person => <tr key={person.user_id}>
        <td>{person.name || person.email || "Account"}<small className="admin-member-email">{person.email}</small></td>
        <td>{person.roles.map(roleLabel).join(", ")}</td>
        <td>{[person.roles.includes("manager") ? (runs(person.user_id).map(team => `leads ${team.name}`).join(", ") || "Leads no team yet") : "", teamsOf(person)].filter(Boolean).join(" · ") || "—"}</td>
        <td>{person.suspended_at ? <span title={person.suspended_reason || ""}>Suspended</span> : "Active"}</td>
        <td>{!isOwnerRow(person) && <span className="admin-row-actions">
          {leads && <button type="button" className="staff-text-button" disabled={busy} onClick={() => { setEditing(person.user_id); setRole(person.roles[0] || "caller"); setRoleList(person.roles); setTeamId(person.team_ids?.[0] || ""); setTeamList(person.team_ids || []); setMessage(""); }}>Change role or team</button>}
          {(leads || (you.manager && isAgent(person.roles[0] || ""))) && <button type="button" className="staff-text-button" disabled={busy} onClick={() => void suspend(person)}>{person.suspended_at ? "Restore" : "Suspend"}</button>}
          {leads && <button type="button" className="staff-text-button" disabled={busy} onClick={() => void remove(person)}>Remove</button>}
        </span>}</td>
      </tr>)}</tbody></table></div></div>
    </>}
    {editing && <form className="staff-form" onSubmit={save}><div className="staff-fields">
      {teamsV2 ? <>
        <label>Roles for {nameOf(editing)}<select multiple size={Math.min(5, roles.length)} value={roleList} onChange={event => setRoleList(picked(event.currentTarget))}>{roles.map(value => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>
        {roleList.some(isAgent) && <label>Teams (up to five)<select multiple size={Math.min(5, Math.max(2, teams.length))} value={teamList} onChange={event => setTeamList(picked(event.currentTarget).slice(0, 5))}>{teams.map(team => <option key={team.team_id} value={team.team_id}>{team.name}</option>)}</select></label>}
        <button className="button primary" disabled={busy || !roleList.length || (roleList.some(isAgent) && !teamList.length)}>{busy ? "Saving…" : "Save"}</button>
      </> : <>
        <label>Role for {nameOf(editing)}<select value={role} onChange={event => setRole(event.target.value)}>{roles.map(value => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>
        {isAgent(role) && <label>Team<select required value={teamId} onChange={event => setTeamId(event.target.value)}><option value="">Choose a team</option>{teams.map(team => <option key={team.team_id} value={team.team_id}>{team.name}</option>)}</select></label>}
        <button className="button primary" disabled={busy || (isAgent(role) && !teamId)}>{busy ? "Saving…" : "Save"}</button>
      </>}<button type="button" className="button raised" onClick={() => setEditing("")}>Cancel</button>
    </div></form>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
