import { useCallback, useEffect, useState } from "react";
import type { Auth } from "@callerwhale/auth-client";
import { mcpUrl } from "./crm-url.ts";
import { hasCrmAccess } from "./crm-access.ts";

// Settings, Connections. AI assistants connect FROM the assistant (it is given the address below and sends the person back here to
// allow it), so this page shows that address, how to add it, and what is connected, with an End button. The tools (ClickUp, Google
// Meet, MyVirtualTracker) are not built yet and say so.

type Connection = { id: string; name: string; scope: string; created_at: number; last_used_at: number | null };

const ASSISTANTS = [
  { name: "Claude", steps: "Settings → Connectors → Add custom connector. Paste the address and sign in to Caller Whale when asked." },
  { name: "ChatGPT", steps: "Settings → Connectors → Create (developer mode). Paste the address and choose OAuth." },
  { name: "Gemini", steps: "Add it as a remote MCP server where your Gemini tool supports one, with this address." },
];

const TOOLS = [
  { name: "ClickUp", what: "Send tasks and follow-ups from Caller Whale to ClickUp." },
  { name: "Google Meet", what: "Start and log Google Meet calls from a lead." },
  { name: "MyVirtualTracker", what: "Send call and work data to MyVirtualTracker." },
];

const when = (seconds: number | null) => seconds ? new Date(seconds * 1000).toLocaleString() : "not used yet";

export function SettingsConnections({ auth, authBase }: { auth: Auth; authBase: string }) {
  const [list, setList] = useState<Connection[] | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [ending, setEnding] = useState("");
  // Assistants are for staff and people in a workspace; anyone else is told so instead of being shown the address.
  const [allowed, setAllowed] = useState<boolean | null>(null);

  const call = useCallback(async (method: string, path: string) => {
    const token = await auth.accessToken();
    if (!token) throw new Error("Sign in again to continue.");
    const response = await fetch(`${authBase}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "That did not work. Try again.");
    return body;
  }, [auth, authBase]);

  const load = useCallback(() => {
    call("GET", "/v1/me/connections").then(body => { setList(body.connections); setError(""); }).catch(reason => setError(reason instanceof Error ? reason.message : "Could not load your connections."));
  }, [call]);
  useEffect(() => load(), [load]);
  useEffect(() => { call("GET", "/v1/me/access").then(body => setAllowed(hasCrmAccess(body))).catch(() => setAllowed(true)); }, [call]); // if it cannot be checked, the service still refuses

  const copy = async () => {
    try { await navigator.clipboard.writeText(mcpUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the address is on screen to copy by hand */ }
  };
  const end = async (item: Connection) => {
    if (!window.confirm(`End the connection with ${item.name}? It stops working at once.`)) return;
    setEnding(item.id);
    try { await call("DELETE", `/v1/me/connections/${item.id}`); load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not end it."); }
    setEnding("");
  };

  return (
    <div className="settings-stack">
      {allowed === false ? (
        <section className="card profile-card" aria-labelledby="assistants-title">
          <h2 id="assistants-title">AI assistants</h2>
          <p className="muted">Connecting an assistant is for Caller Whale staff and people who belong to a workspace. You will see it here once you do.</p>
        </section>
      ) : (
      <section className="card profile-card" aria-labelledby="assistants-title">
        <h2 id="assistants-title">AI assistants</h2>
        <p className="muted">Let Claude, ChatGPT or Gemini see your Caller Whale account. Today that means your name, role, workspaces and plan usage, read only.</p>
        <div className="connect-address">
          <code>{mcpUrl}</code>
          <button type="button" className="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy address"}</button>
        </div>
        <ul className="settings-list">
          {ASSISTANTS.map(item => <li key={item.name}><span><strong>{item.name}</strong><small className="muted">{item.steps}</small></span></li>)}
        </ul>
      </section>
      )}

      <section className="card profile-card" aria-labelledby="connected-title">
        <h2 id="connected-title">Connected now</h2>
        {error && <p className="notice bad" role="alert">{error} <button type="button" className="text-button" onClick={load}>Try again</button></p>}
        {!error && list === null && <p className="muted" role="status"><span className="spinner" aria-hidden="true" />Loading…</p>}
        {list && list.length === 0 && <p className="muted">Nothing is connected yet.</p>}
        {list && list.length > 0 && (
          <ul className="settings-list">
            {list.map(item => (
              <li key={item.id}>
                <span><strong>{item.name}</strong><small className="muted">Connected {when(item.created_at)} · last used {when(item.last_used_at)}</small></span>
                <button type="button" className="button" disabled={ending === item.id} onClick={() => void end(item)}>{ending === item.id ? "Ending…" : "End"}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card profile-card" aria-label="Tools">
        <h2>Tools</h2>
        <ul className="settings-list">
          {TOOLS.map(item => <li key={item.name}><span><strong>{item.name}</strong><small className="muted">{item.what}</small></span><span className="role-badge is-off">Coming soon</span></li>)}
        </ul>
      </section>
    </div>
  );
}
