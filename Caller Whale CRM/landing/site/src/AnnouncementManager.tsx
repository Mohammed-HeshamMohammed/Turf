import { useEffect, useState, type FormEvent } from "react";
import type { Auth } from "@callerwhale/auth-client";
import type { Announcement } from "./Announcement.tsx";
import type { Api } from "./OwnerViews.tsx";
import { needsSecondStep, useSecondStep } from "./SecondStep.tsx";

const tones = { info: "Information", promo: "Promotion", warning: "Important notice" };
const fieldsOf = (a: Announcement) => JSON.stringify([a.enabled, a.message, a.tone, a.link_label, a.link_url, a.tab_enabled, a.tab_text, a.tab_url]);
const linkProblem = (url: string) => (url && !((url.startsWith("/") && !url.startsWith("//")) || url.startsWith("https://")) ? "Start with / for a page on this site, or https://." : "");

function Switch({ checked, onChange, children }: { checked: boolean; onChange: (on: boolean) => void; children: string }) {
  return <label className="ann-switch"><input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} /><span className="ann-track" aria-hidden="true" /><span>{children}</span></label>;
}

/** Dashboard editor for the banner and the side tab. Any platform staff member may change them; nothing goes live until Save. */
export function AnnouncementManager({ request, auth }: { request: Api; auth: Auth }) {
  const [saved, setSaved] = useState<Announcement | null>(null);
  const [form, setForm] = useState<Announcement | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const second = useSecondStep(auth, "Changing the announcement needs a code entered just now.");
  useEffect(() => { request("GET", "/v1/announcement").then(data => { setSaved(data); setForm(data); }, () => setMessage("The announcement could not be loaded.")); }, []);
  if (!form || !saved) return <p role="status" className="muted">{message || "Loading…"}</p>;
  const set = (change: Partial<Announcement>) => { setForm({ ...form, ...change }); setMessage(""); };
  const dirty = fieldsOf(form) !== fieldsOf(saved);
  const bannerError = form.enabled && !form.message.trim() ? "Write the message to turn the banner on." : form.link_url && !form.link_label.trim() ? "Add the text for the link." : linkProblem(form.link_url);
  const tabError = form.tab_enabled && !form.tab_text.trim() ? "Write the tab text to turn the tab on." : form.tab_enabled ? linkProblem(form.tab_url) || (form.tab_url ? "" : "Add where the tab goes.") : "";
  const save = (event: FormEvent) => {
    event.preventDefault();
    return second.guard(async () => {
      setBusy(true); setMessage("");
      try { const next = await request("PUT", "/v1/admin/announcement", form); setSaved(next); setForm(next); setMessage("Saved. Visitors see the change the next time a page loads."); }
      catch (problem) {
        if (needsSecondStep(problem)) { setBusy(false); throw problem; }
        setMessage(problem instanceof Error ? problem.message : "Could not save the announcement.");
      }
      setBusy(false);
    });
  };
  const status = (on: boolean, was: boolean) => <span className={`ann-status${on ? " is-on" : ""}`}>{on ? "Live" : "Off"}{on !== was && " · after you save"}</span>;
  return <form className="ann" onSubmit={save} aria-label="Announcement settings">
    {second.prompt}
    <p className="muted ann-intro">Two things visitors see on the public site. Changes go live only when you press Save.</p>
    <div className="ann-grid">
      <section className="card ann-card" aria-labelledby="ann-banner-title">
        <header><div><span className="eyebrow">Top of every page</span><h2 id="ann-banner-title">Announcement banner</h2></div>{status(form.enabled, saved.enabled)}</header>
        <Switch checked={form.enabled} onChange={enabled => set({ enabled })}>Show the banner</Switch>
        <div className="ann-preview" aria-label="Preview">
          <div className={`announcement announcement-${form.tone}`}><p>{form.message.trim() || "Your message appears here."}{form.link_url && form.link_label && <a href={form.link_url} onClick={event => event.preventDefault()}>{form.link_label}</a>}</p><button type="button" tabIndex={-1} aria-hidden="true">✕</button></div>
          {!form.enabled && <span className="ann-preview-off">Hidden from visitors</span>}
        </div>
        <label className="ann-field">Message<input maxLength={200} value={form.message} onChange={event => set({ message: event.target.value })} placeholder="New: shared inbox for your whole team." /><small>{form.message.length} / 200</small></label>
        <div className="ann-row">
          <label className="ann-field">Style<select value={form.tone} onChange={event => set({ tone: event.target.value as Announcement["tone"] })}>{Object.entries(tones).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          <label className="ann-field">Link text (optional)<input maxLength={30} value={form.link_label} onChange={event => set({ link_label: event.target.value })} placeholder="Learn more" /></label>
          <label className="ann-field">Link address (optional)<input maxLength={300} value={form.link_url} onChange={event => set({ link_url: event.target.value })} placeholder="/pricing or https://…" /></label>
        </div>
        {bannerError && <p className="notice bad" role="alert">{bannerError}</p>}
      </section>
      <section className="card ann-card" aria-labelledby="ann-tab-title">
        <header><div><span className="eyebrow">Home page, right edge</span><h2 id="ann-tab-title">Side tab</h2></div>{status(form.tab_enabled, saved.tab_enabled)}</header>
        <Switch checked={form.tab_enabled} onChange={tab_enabled => set({ tab_enabled })}>Show the side tab</Switch>
        <div className="ann-preview ann-tab-stage" aria-label="Preview">
          {form.tab_enabled ? <span className="hero-side-cta ann-tab-sample">{form.tab_text.trim() || "Tab text"} <span aria-hidden="true">↗</span></span> : <span className="ann-preview-off">Hidden from visitors</span>}
        </div>
        <label className="ann-field">Tab text<input maxLength={30} value={form.tab_text} onChange={event => set({ tab_text: event.target.value })} placeholder="Start for free" /><small>{form.tab_text.length} / 30</small></label>
        <label className="ann-field">Where it goes<input maxLength={300} value={form.tab_url} onChange={event => set({ tab_url: event.target.value })} placeholder="/signup or https://…" /></label>
        <p className="muted">Signed-in visitors never see this tab.</p>
        {tabError && <p className="notice bad" role="alert">{tabError}</p>}
      </section>
    </div>
    <div className="ann-savebar" role="status">
      <span>{message || (dirty ? "You have unsaved changes." : saved.updated_at ? `Last saved ${new Date(saved.updated_at * 1000).toLocaleString()}.` : "Nothing saved yet.")}</span>
      <button type="button" className="button" disabled={!dirty || busy} onClick={() => { setForm(saved); setMessage(""); }}>Discard changes</button>
      <button className="button primary" disabled={!dirty || busy || Boolean(bannerError || tabError)}>{busy ? "Saving…" : "Save"}</button>
    </div>
  </form>;
}
