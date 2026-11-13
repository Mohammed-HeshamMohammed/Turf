import { useEffect, useState, type FormEvent } from "react";
import { Link } from "./nav.tsx";
import type { Auth } from "./auth/auth-client.js";
import type { Api } from "./OwnerViews.tsx";
import { needsSecondStep, useSecondStep } from "./SecondStep.tsx";

type Announcement = { enabled: boolean; message: string; link_label: string; link_url: string; tone: "info" | "promo" | "warning"; updated_at: number };
const tones = { info: "Information", promo: "Promotion", warning: "Important notice" };
const dismissKey = (a: Announcement) => `cw-announcement-${a.updated_at}`;

/** The banner across the top of the public site; the text is set by staff in the dashboard. Shows nothing until it loads or when switched off. */
export function AnnouncementBanner({ authBase }: { authBase: string }) {
  const [a, setA] = useState<Announcement | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`${authBase}/v1/announcement`).then(res => (res.ok ? res.json() : null)).then((data: Announcement | null) => {
      if (!live || !data?.enabled || !data.message) return;
      try { if (window.sessionStorage.getItem(dismissKey(data))) return; } catch { /* storage blocked: show it */ }
      setA(data);
    }, () => {});
    return () => { live = false; };
  }, [authBase]);
  if (!a || hidden) return null;
  const close = () => { setHidden(true); try { window.sessionStorage.setItem(dismissKey(a), "1"); } catch { /* shown again next visit */ } };
  return <div className={`announcement announcement-${a.tone}`} role="region" aria-label="Announcement">
    <p>{a.message}{a.link_url && (a.link_url.startsWith("/") ? <Link to={a.link_url}>{a.link_label}</Link> : <a href={a.link_url} rel="noopener noreferrer">{a.link_label}</a>)}</p>
    <button type="button" onClick={close} aria-label="Dismiss announcement">✕</button>
  </div>;
}

/** Dashboard editor for the banner. Any platform staff member may change it. */
export function AnnouncementManager({ request, auth }: { request: Api; auth: Auth }) {
  const [form, setForm] = useState<Announcement | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const second = useSecondStep(auth, "Changing the announcement needs a code entered just now.");
  useEffect(() => { request("GET", "/v1/announcement").then(setForm, () => setMessage("The announcement could not be loaded.")); }, []);
  if (!form) return <p role="status" className="muted">{message || "Loading…"}</p>;
  const set = (change: Partial<Announcement>) => setForm({ ...form, ...change });
  const save = (event: FormEvent) => {
    event.preventDefault();
    return second.guard(async () => {
      setBusy(true); setMessage("");
      try { setForm(await request("PUT", "/v1/admin/announcement", form)); setMessage(form.enabled ? "Saved. The banner is showing on the site." : "Saved. The banner is off."); }
      catch (problem) {
        if (needsSecondStep(problem)) { setBusy(false); throw problem; }
        setMessage(problem instanceof Error ? problem.message : "Could not save the announcement.");
      }
      setBusy(false);
    });
  };
  return <section className="admin-manage card" aria-labelledby="announcement-title">
    <div><span className="eyebrow">Platform staff</span><h2 id="announcement-title">Announcement banner</h2><p className="muted">A line across the top of every public page. Visitors can dismiss it; changing the text shows it to them again.</p></div>
    {second.prompt}
    <form className="staff-form" onSubmit={save}>
      <div className="staff-fields">
        <label className="announcement-switch"><input type="checkbox" checked={form.enabled} onChange={event => set({ enabled: event.target.checked })} /> Show the banner</label>
        <label>Message<input maxLength={200} value={form.message} onChange={event => set({ message: event.target.value })} placeholder="New: shared inbox for your whole team." /></label>
        <label>Style<select value={form.tone} onChange={event => set({ tone: event.target.value as Announcement["tone"] })}>{Object.entries(tones).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>Link text (optional)<input maxLength={30} value={form.link_label} onChange={event => set({ link_label: event.target.value })} placeholder="Learn more" /></label>
        <label>Link address (optional)<input maxLength={300} value={form.link_url} onChange={event => set({ link_url: event.target.value })} placeholder="/pricing or https://…" /></label>
        <button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
      {message && <p className="notice" role="status">{message}</p>}
    </form>
    {form.message && <div className={`announcement announcement-${form.tone}`} aria-label="Preview"><p>{form.message}{form.link_url && <a href={form.link_url} onClick={event => event.preventDefault()}>{form.link_label}</a>}</p></div>}
  </section>;
}
