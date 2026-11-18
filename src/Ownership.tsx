import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Auth } from "./auth/auth-client.js";

// Build step 13: handing an agency to a new owner (D28, D70, D199, D200), and an agency whose owner is gone (D27, D201).

type Handover = { id: string; org_id: string; org_name: string; kind: string; from_id: string; from_name: string; to_id: string; to_name: string; old_roles: string[]; created_at: number; expires_at: number };
type Member = { user_id: string; name?: string; email?: string; roles: string[] };

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const nextRole = (roles: string[]) => roles.includes("admin") ? "an admin" : roles.includes("manager") ? "a team lead" : "leaving the agency";

function useRequest(auth: Auth, authBase: string) {
  return useCallback(async (path: string, method = "GET", body?: unknown) => {
    const token = await auth.accessToken();
    if (!token) throw new Error("Sign in again.");
    const response = await fetch(`${authBase}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || "That did not work. Try again in a moment."), { code: result.code });
    return result;
  }, [auth, authBase]);
}

/** Agencies whose owner offered them to the signed-in person: accept (with the second step, and paying where the agency is paid for) or decline. */
export function OfferedAgencies({ auth, authBase }: { auth: Auth; authBase: string }) {
  const request = useRequest(auth, authBase);
  const [offers, setOffers] = useState<Handover[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => request("/v1/me/handovers").then(result => setOffers(result.handovers || []), () => setOffers([])), [request]);
  useEffect(() => { void load(); }, [load]);
  const act = async (offer: Handover, accept: boolean) => {
    if (accept && !confirm(`Become the owner of ${offer.org_name || "this agency"}? You will run it and pay for its plan.`)) return;
    setBusy(offer.id);
    try {
      await request(`/v1/me/handovers/${offer.id}/${accept ? "accept" : "decline"}`, "POST");
      setMessage(accept ? `You now own ${offer.org_name || "the agency"}.` : "Declined. Nothing changed.");
      await load();
    } catch (error) {
      const code = (error as { code?: string }).code;
      setMessage(code === "mfa_required" ? "Turn on two-step sign-in and sign in with it, then accept." : error instanceof Error ? error.message : "That did not work.");
    } finally { setBusy(""); }
  };
  if (!offers.length && !message) return null;
  return <section className="card" aria-labelledby="offered-agencies">
    <h2 id="offered-agencies">Agencies offered to you</h2>
    {message && <p className="notice" role="status">{message}</p>}
    <ul className="membership-list">
      {offers.map(offer => <li key={offer.id}>
        <span><strong>{offer.org_name || "An agency"}</strong> <span className="muted">from {offer.from_name || "its owner"}, until {day(offer.expires_at)}. They become {nextRole(offer.old_roles)}.</span></span>
        <span><button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void act(offer, true)}>Accept</button> <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void act(offer, false)}>Decline</button></span>
      </li>)}
    </ul>
  </section>;
}

/** The owner hands the agency to a member, choosing what they become; the offer waits 7 days and can be cancelled. */
export function HandOver({ auth, authBase, orgId }: { auth: Auth; authBase: string; orgId: string }) {
  const request = useRequest(auth, authBase);
  const [members, setMembers] = useState<Member[]>([]);
  const [waiting, setWaiting] = useState<Handover | null>(null);
  const [to, setTo] = useState("");
  const [role, setRole] = useState("admin");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [listed, open] = await Promise.all([request(`/v1/orgs/${orgId}/members`), request(`/v1/orgs/${orgId}/handover`)]);
      setMembers((listed.members || []).filter((m: Member) => !m.roles.includes("owner") && !m.roles.includes("solo") && m.roles.some(r => r !== "client")));
      setWaiting(open.handover || null);
    } catch { /* the card stays empty */ }
  }, [request, orgId]);
  useEffect(() => { void load(); }, [load]);
  const offer = async (event: FormEvent) => {
    event.preventDefault();
    if (!to || !confirm("Offer the agency to this member? Once they accept, they own it and you become what you chose.")) return;
    setBusy(true);
    try { await request(`/v1/orgs/${orgId}/handover`, "POST", { to, old_role: role }); setMessage("Offered. They have 7 days to accept."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The offer could not be made."); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true);
    try { await request(`/v1/orgs/${orgId}/handover`, "DELETE"); setMessage("Cancelled. Nothing changed."); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "It could not be cancelled."); }
    finally { setBusy(false); }
  };
  return <section className="card" aria-labelledby={`handover-${orgId}`}>
    <h2 id={`handover-${orgId}`}>Hand over this agency</h2>
    {waiting ? <>
      <p>Offered to <strong>{waiting.to_name || "a member"}</strong> until {day(waiting.expires_at)}. You become {nextRole(waiting.old_roles)} when they accept.</p>
      <button type="button" className="button" disabled={busy} onClick={() => void cancel()}>Cancel the offer</button>
    </> : <form onSubmit={offer} className="staff-fields">
      <p className="muted">The new owner accepts with their second step and pays for the plan from then on; your card is not charged again.</p>
      <label>New owner<select required value={to} onChange={event => setTo(event.target.value)}><option value="">Choose a member</option>{members.map(m => <option key={m.user_id} value={m.user_id}>{m.name || m.email || m.user_id}</option>)}</select></label>
      <label>You become<select value={role} onChange={event => setRole(event.target.value)}><option value="admin">An admin</option><option value="manager">A team lead</option><option value="leave">Nothing: I leave the agency</option></select></label>
      <button className="button" disabled={busy || !to}>Offer the agency</button>
    </form>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}

/** An admin of an agency whose owner cannot be reached asks Caller Whale to hand it to them (D201). */
export async function askTakeover(auth: Auth, authBase: string, orgId: string) {
  if (!confirm("Ask Caller Whale to make you the owner of this agency? This is for an agency whose owner cannot be reached; Caller Whale checks before anything changes.")) return;
  const token = await auth.accessToken();
  const response = await fetch(`${authBase}/v1/orgs/${orgId}/takeover`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const result = await response.json().catch(() => ({}));
  alert(response.ok ? "Asked. Caller Whale checks the request; it can be approved once the agency has been paused for 14 days." : result.error || "The request could not be sent.");
}

/** Staff: pause an agency whose owner is gone (members read, nobody works), and decide admins' takeover requests (D27, D201). */
export function OwnerlessAgencies({ auth, authBase }: { auth: Auth; authBase: string }) {
  const request = useRequest(auth, authBase);
  const [requests, setRequests] = useState<{ request: Handover; paused_at: number; can_be_approved_at: number }[]>([]);
  const [org, setOrg] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(() => request("/v1/admin/takeovers").then(result => setRequests(result.requests || []), () => setRequests([])), [request]);
  useEffect(() => { void load(); }, [load]);
  const run = async (work: () => Promise<unknown>, done: string) => {
    try { await work(); setMessage(done); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "That did not work."); }
  };
  return <section className="card" aria-labelledby="ownerless-title">
    <div><span className="eyebrow">Agencies without an owner</span><h2 id="ownerless-title">Pause and hand on</h2>
      <p className="muted">Pause an agency whose owner cannot be reached: its members can read but not work. An admin of it can then ask to take it over; approve after 14 days paused.</p></div>
    <form className="staff-fields" onSubmit={event => { event.preventDefault(); void run(() => request(`/v1/admin/workspaces/${org.trim()}/paused`, "PUT", { on: true }), "Paused."); }}>
      <label>Workspace id<input value={org} onChange={event => setOrg(event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" /></label>
      <button className="button" disabled={!org.trim()}>Pause</button>
      <button type="button" className="button" disabled={!org.trim()} onClick={() => void run(() => request(`/v1/admin/workspaces/${org.trim()}/paused`, "PUT", { on: false }), "The pause ended.")}>End the pause</button>
    </form>
    {requests.length === 0 ? <p className="muted">No takeover requests.</p> : <ul className="membership-list">
      {requests.map(item => <li key={item.request.id}>
        <span><strong>{item.request.org_name || item.request.org_id}</strong> <span className="muted">· {item.request.to_name || "an admin"} asks to take it over from {item.request.from_name || "its owner"}. {item.paused_at ? `Paused since ${day(item.paused_at)}; can be approved from ${day(item.can_be_approved_at)}.` : "Not paused."}</span></span>
        <span><button type="button" className="button primary" onClick={() => void run(() => request(`/v1/admin/takeovers/${item.request.id}/approve`, "POST"), "Handed over.")}>Approve</button> <button type="button" className="button" onClick={() => void run(() => request(`/v1/admin/takeovers/${item.request.id}/reject`, "POST"), "Rejected.")}>Reject</button></span>
      </li>)}
    </ul>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}

type Stage = { stage: string; owner?: boolean; grace_ends?: number; read_only_ends?: number; delete_at?: number; closed_at?: number | null };

/** Step 18: where an agency stands with its plan, said to the people it concerns (D80, D204, D205, D206), and the owner's close and
 * reopen with 30 days to change their mind (D82). */
export function AgencyStanding({ auth, authBase, orgId }: { auth: Auth; authBase: string; orgId: string }) {
  const request = useRequest(auth, authBase);
  const [stage, setStage] = useState<Stage | null>(null);
  const [message, setMessage] = useState("");
  const load = useCallback(() => request(`/v1/orgs/${orgId}/plan-stage`).then(setStage, () => setStage(null)), [request, orgId]);
  useEffect(() => { void load(); }, [load]);
  const change = async (close: boolean) => {
    if (close && !confirm("Close this agency? Everyone in it loses access at once. For 30 days you can reopen it or export its data; after that it is deleted.")) return;
    try { await request(`/v1/orgs/${orgId}/${close ? "close" : "reopen"}`, "POST"); setMessage(close ? "The agency is closed." : "The agency is open again."); await load(); }
    catch (error) {
      const code = (error as { code?: string }).code;
      setMessage(code === "mfa_required" ? "Sign in with two-step sign-in first." : error instanceof Error ? error.message : "That did not work.");
    }
  };
  if (!stage) return null;
  const text = {
    grace: `The plan is unpaid. Everything keeps working until ${stage.grace_ends ? day(stage.grace_ends) : "the grace period ends"}; then the agency becomes read-only.`,
    read_only: `The agency is read-only until its plan is paid: people can read and export, but not call, text, import or invite.${stage.read_only_ends ? ` It closes on ${day(stage.read_only_ends)}.` : ""}`,
    closed: `The agency is closed.${stage.delete_at ? ` Its data is deleted on ${day(stage.delete_at)} unless it is reopened.` : ""}`,
  }[stage.stage as "grace" | "read_only" | "closed"];
  if (!text && !stage.owner) return null;
  return <section className="card" aria-labelledby={`standing-${orgId}`}>
    <h2 id={`standing-${orgId}`}>{stage.stage === "closed" ? "Agency closed" : stage.stage ? "Plan needs paying" : "Close this agency"}</h2>
    {text ? <p className={stage.stage === "grace" ? "notice" : "notice bad"} role="status">{text}</p> : <p className="muted">Closing ends everyone's access at once. You can reopen it or export its data for 30 days.</p>}
    {stage.owner && (stage.closed_at ? <button type="button" className="button primary" onClick={() => void change(false)}>Reopen the agency</button> : <button type="button" className="button" onClick={() => void change(true)}>Close the agency</button>)}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
