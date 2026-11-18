import { useEffect, useState } from "react";
import { Link } from "./nav.tsx";

// Build step 34: the public status page and the outage banner (D235). Both read GET /v1/status from the auth service.

type Part = { id: string; name: string; state: "up" | "degraded" | "down"; since: number | null };
type Incident = { id: string; components: string[]; severity: "degraded" | "down"; title: string; message: string; started_at: number; resolved_at: number | null; updates: { at: number; message: string }[] };
type Status = { parts: Part[]; open: Incident[]; past: Incident[]; banner: { title: string; severity: string; link: string } | null };

let loading: Promise<Status | null> | null = null;
const loadStatus = (authBase: string, fresh = false) => {
  if (fresh || !loading) loading = fetch(`${authBase}/v1/status`).then(res => (res.ok ? (res.json() as Promise<Status>) : null), () => null);
  return loading;
};

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const words = { up: "Working", degraded: "Slow or partly working", down: "Not working" };

/** The banner every page shows while something is not working; it links to the status page. */
export function OutageBanner({ authBase }: { authBase: string }) {
  const [banner, setBanner] = useState<Status["banner"]>(null);
  useEffect(() => {
    let live = true;
    const check = () => loadStatus(authBase, true).then(s => { if (live) setBanner(s?.banner ?? null); });
    check();
    const timer = window.setInterval(check, 120000);
    return () => { live = false; window.clearInterval(timer); };
  }, [authBase]);
  if (!banner) return null;
  return (
    <div className={`announcement announcement-warning`} role="status">
      <span>{banner.title}</span> <Link to="/status">See the status</Link>
    </div>
  );
}

/** The public status page: each part of Caller Whale, what is happening now, and the last 30 days. */
export function StatusPage({ authBase }: { authBase: string }) {
  const [status, setStatus] = useState<Status | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    loadStatus(authBase, true).then(s => { if (live) setStatus(s); });
    return () => { live = false; };
  }, [authBase]);
  if (status === undefined) return <section className="form-wrap"><p className="muted" role="status">Checking…</p></section>;
  if (status === null) return <section className="form-wrap"><h1>Status</h1><p>The status cannot be read right now. If Caller Whale is not working for you, please try again in a few minutes.</p></section>;
  const allUp = status.parts.every(p => p.state === "up");
  return (
    <section className="form-wrap status-page">
      <h1>Status</h1>
      <p className="lede">{allUp ? "Everything is working." : "Some parts of Caller Whale are not working as they should."}</p>
      <ul className="status-parts">
        {status.parts.map(p => (
          <li key={p.id} className={`status-${p.state}`}>
            <strong>{p.name}</strong> <span>{words[p.state]}</span>{p.since && p.state !== "up" ? <span className="muted"> since {when(p.since)}</span> : null}
          </li>
        ))}
      </ul>
      {status.open.length > 0 && <h2>Now</h2>}
      {status.open.map(i => <IncidentCard key={i.id} incident={i} />)}
      <h2>The last 30 days</h2>
      {status.past.length === 0 ? <p className="muted">Nothing went wrong.</p> : status.past.map(i => <IncidentCard key={i.id} incident={i} />)}
      <p className="muted">Signed in, you can choose to get an email when something is down, in your account settings.</p>
    </section>
  );
}

function IncidentCard({ incident }: { incident: Incident }) {
  return (
    <article className="status-incident">
      <h3>{incident.title}</h3>
      <p className="muted">{when(incident.started_at)}{incident.resolved_at ? ` to ${when(incident.resolved_at)}` : " · still going on"}</p>
      {incident.message && <p>{incident.message}</p>}
      {incident.updates.map(u => <p key={u.at}><span className="muted">{when(u.at)}:</span> {u.message}</p>)}
    </article>
  );
}
