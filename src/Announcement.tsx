import { useEffect, useState } from "react";
import { Link } from "./nav.tsx";

export type Announcement = { enabled: boolean; message: string; link_label: string; link_url: string; tone: "info" | "promo" | "warning"; updated_at: number; tab_enabled: boolean; tab_text: string; tab_url: string };
const tabDefaults = { tab_enabled: true, tab_text: "Start for free", tab_url: "/signup" };
const dismissKey = (a: Announcement) => `cw-announcement-${a.updated_at}`;

let loading: Promise<Announcement | null> | null = null;
/** One request per page load, shared by the banner and the hero tab. */
const loadAnnouncement = (authBase: string) => (loading ??= fetch(`${authBase}/v1/announcement`).then(res => (res.ok ? (res.json() as Promise<Announcement>) : null), () => null));

/** The vertical tab on the hero's right edge. Text, link and on/off come from the same staff-edited settings; the usual tab shows if they cannot be loaded. */
export function HeroSideTab({ authBase }: { authBase: string }) {
  const [tab, setTab] = useState<{ enabled: boolean; text: string; url: string } | null>(null);
  useEffect(() => {
    let live = true;
    loadAnnouncement(authBase).then(data => { if (live) setTab(data ? { enabled: data.tab_enabled, text: data.tab_text, url: data.tab_url } : { enabled: true, text: tabDefaults.tab_text, url: tabDefaults.tab_url }); });
    return () => { live = false; };
  }, [authBase]);
  if (!tab?.enabled) return null;
  const inner = <>{tab.text} <span aria-hidden="true">↗</span></>;
  return tab.url.startsWith("/") ? <Link className="hero-side-cta" to={tab.url}>{inner}</Link> : <a className="hero-side-cta" href={tab.url} rel="noopener noreferrer">{inner}</a>;
}

/** The banner across the top of the public site; the text is set by staff in the dashboard. Shows nothing until it loads or when switched off. */
export function AnnouncementBanner({ authBase }: { authBase: string }) {
  const [a, setA] = useState<Announcement | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let live = true;
    loadAnnouncement(authBase).then(data => {
      if (!live || !data?.enabled || !data.message) return;
      try { if (window.sessionStorage.getItem(dismissKey(data))) return; } catch { /* storage blocked: show it */ }
      setA(data);
    });
    return () => { live = false; };
  }, [authBase]);
  if (!a || hidden) return null;
  const close = () => { setHidden(true); try { window.sessionStorage.setItem(dismissKey(a), "1"); } catch { /* shown again next visit */ } };
  return <div className={`announcement announcement-${a.tone}`} role="region" aria-label="Announcement">
    <p>{a.message}{a.link_url && (a.link_url.startsWith("/") ? <Link to={a.link_url}>{a.link_label}</Link> : <a href={a.link_url} rel="noopener noreferrer">{a.link_label}</a>)}</p>
    <button type="button" onClick={close} aria-label="Dismiss announcement">✕</button>
  </div>;
}
