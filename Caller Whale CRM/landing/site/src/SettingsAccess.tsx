import { useCallback, useEffect, useState } from "react";
import type { Auth } from "./auth/auth-client.js";
import { workspaceRoleName } from "./roles.ts";

type Agency = { org_id: string; name: string; roles: string[]; teams: { id: string; name: string; lead: boolean; deputy: boolean }[]; owner: boolean };
type Session = { id: string; kind: string; created_at: number; last_seen_at: number; current: boolean };

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const deviceName = (kind: string) => kind === "desktop" ? "Desktop app" : kind === "shared" ? "Browser on a shared device" : "Browser";

/** Settings, My access (D91): every agency the person is in with their roles and teams, invitations waiting, the devices signed in,
 * leaving an agency, and a copy of their own data (D99). */
export function SettingsAccess({ auth, authBase }: { auth: Auth; authBase: string }) {
  const [agencies, setAgencies] = useState<Agency[] | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const request = useCallback(async (path: string, method = "GET", body?: unknown) => {
    const token = await auth.accessToken();
    if (!token) throw new Error("Sign in again.");
    const response = await fetch(`${authBase}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "That did not work. Try again in a moment.");
    }
    return response;
  }, [auth, authBase]);

  const load = useCallback(async () => {
    try {
      const [a, s, i] = await Promise.all([request("/v1/me/agencies"), request("/v1/sessions"), request("/v1/me/invitations")]);
      setAgencies((await a.json()).agencies || []);
      setSessions((await s.json()).sessions || []);
      const invitations = (await i.json()).invitations || [];
      setWaiting(invitations.filter((item: { status?: string }) => !item.status || item.status === "pending").length);
      setError("");
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Your access could not be loaded."); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try { await run(); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "That did not work."); }
    finally { setBusy(""); }
  };
  const leave = (agency: Agency) => {
    if (!window.confirm(`Leave ${agency.name}? You lose access at once; your work there stays with the agency.`)) return;
    void act(`leave-${agency.org_id}`, () => request(`/v1/orgs/${encodeURIComponent(agency.org_id)}/leave`, "POST"));
  };
  const signOutDevice = (session: Session) => void act(`out-${session.id}`, () => request("/v1/sessions/revoke", "POST", { session_id: session.id }));
  const signOutOthers = () => void act("others", () => request("/v1/sessions/revoke", "POST", { others: true }));
  const download = () => void act("export", async () => {
    const response = await request("/v1/me/export");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "caller-whale-my-data.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return (
    <div className="settings-stack">
      {error && <p role="alert" className="notice bad">{error}</p>}
      <section className="card profile-card" aria-labelledby="agencies-title">
        <div className="profile-card-head"><h2 id="agencies-title">Your agencies</h2></div>
        {agencies === null ? <p className="muted">Loading…</p> : agencies.length === 0 ? <p className="muted">You are not in any agency yet.</p> : (
          <ul className="access-list">
            {agencies.map(agency => (
              <li key={agency.org_id}>
                <div>
                  <strong>{agency.name}</strong>
                  <span className="muted"> · {agency.roles.map(role => workspaceRoleName(role)).join(", ") || "Member"}</span>
                  {agency.teams.length > 0 && <p className="muted">Teams: {agency.teams.map(team => team.name + (team.lead ? " (lead)" : team.deputy ? " (deputy lead)" : "")).join(", ")}</p>}
                </div>
                {agency.owner ? <span className="role-badge">Owner</span> : <button type="button" className="button" disabled={Boolean(busy)} onClick={() => leave(agency)}>{busy === `leave-${agency.org_id}` ? "Leaving…" : "Leave"}</button>}
              </li>
            ))}
          </ul>
        )}
        {waiting > 0 && <p className="notice" role="status">{waiting === 1 ? "1 invitation is" : `${waiting} invitations are`} waiting for you. <a href="/dashboard">Open your dashboard</a> to accept or decline.</p>}
      </section>
      <section className="card profile-card" aria-labelledby="devices-title">
        <div className="profile-card-head"><h2 id="devices-title">Signed-in devices</h2>{sessions && sessions.length > 1 && <button type="button" className="button" disabled={Boolean(busy)} onClick={signOutOthers}>Sign out everywhere else</button>}</div>
        {sessions === null ? <p className="muted">Loading…</p> : (
          <ul className="access-list">
            {sessions.map(session => (
              <li key={session.id}>
                <div><strong>{deviceName(session.kind)}</strong>{session.current && <span className="role-badge">This device</span>}<p className="muted">Signed in {when(session.created_at)} · last used {when(session.last_seen_at)}</p></div>
                {!session.current && <button type="button" className="button" disabled={Boolean(busy)} onClick={() => signOutDevice(session)}>{busy === `out-${session.id}` ? "Signing out…" : "Sign out"}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card profile-card" aria-labelledby="data-title">
        <div className="profile-card-head"><h2 id="data-title">Your data</h2><button type="button" className="button" disabled={Boolean(busy)} onClick={download}>{busy === "export" ? "Preparing…" : "Download my data"}</button></div>
        <p className="muted">A file with your profile, settings, sign-ins and agencies. An agency's leads, calls and chats belong to the agency; its owner can export them.</p>
      </section>
    </div>
  );
}
