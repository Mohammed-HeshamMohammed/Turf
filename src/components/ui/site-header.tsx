import { useEffect, useRef, useState } from "react";
import type { Me } from "../../auth/auth-client.js";
import { Link } from "../../nav.tsx";

const links = [
  { label: "Features", to: "/features" },
  { label: "Why Caller Whale", to: "/why-caller-whale" },
  { label: "Pricing", to: "/pricing" },
  { label: "Security", to: "/security" },
  { label: "Contact", to: "/contact" },
];

type Shown = { name?: string; email?: string; avatar?: unknown };

export function SiteHeader({ path, me, onSignOut, savedSession = false, cached = null, openCrm }: { path: string; me: Me | null | undefined; onSignOut: () => void; savedSession?: boolean; cached?: Shown | null; openCrm?: () => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [detached, setDetached] = useState(false);
  const header = useRef<HTMLElement>(null);
  const accountMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => { setMobileOpen(false); if (accountMenu.current) accountMenu.current.open = false; }, [path]);
  useEffect(() => {
    const sync = () => setDetached(window.scrollY > 64);
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, []);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (accountMenu.current && !accountMenu.current.contains(event.target as Node)) accountMenu.current.open = false;
      if (header.current && !header.current.contains(event.target as Node)) setMobileOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { if (accountMenu.current) accountMenu.current.open = false; setMobileOpen(false); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  const nav = links.map(link => <Link key={link.to} to={link.to} aria-current={path === link.to || (link.to === "/features" && path.startsWith("/features/")) ? "page" : undefined}>{link.label}</Link>);
  const menu = (known: Shown) => <details className="account-menu" ref={accountMenu}>
    <summary aria-label={`Account menu for ${known.name || known.email}`} title="Account menu"><span className="avatar" aria-hidden="true">{known.avatar ? <img src={String(known.avatar)} alt="" /> : (known.name || known.email || "C").trim().charAt(0).toUpperCase()}</span></summary>
    <div className="account-popover"><span className="account-identity">{known.name || "Your account"}<small>{known.email}</small></span><Link to="/dashboard" onClick={() => { if (accountMenu.current) accountMenu.current.open = false; }}>Dashboard</Link>{openCrm && <button type="button" onClick={() => { if (accountMenu.current) accountMenu.current.open = false; openCrm(); }}>Open CRM</button>}<Link to="/account" onClick={() => { if (accountMenu.current) accountMenu.current.open = false; }}>Settings</Link><button type="button" onClick={() => { if (accountMenu.current) accountMenu.current.open = false; onSignOut(); }}>Sign out</button></div>
  </details>;
  // What is known at once: the person, or (while the session is still being checked) the last-known profile kept on this device.
  const known = me || (me === undefined && savedSession ? cached : null);
  const account = known ? menu(known) : me === undefined && savedSession ? <span className="avatar avatar-pending" aria-hidden="true" /> : <div className="site-auth"><Link to="/signin">Sign in</Link><Link className="site-signup" to="/signup">Sign up</Link></div>;
  return <header ref={header} className={`site-header${path === "/" ? detached ? " is-detached" : " is-on-hero" : ""}`}>
    <Link className="site-brand" to="/"><img src="/favicon.svg" alt="" width="34" height="34" />Caller Whale</Link>
    <nav className="site-nav" aria-label="Main">{nav}</nav>
    <div className="site-header-end">{account}<button type="button" className="site-menu-toggle" aria-label="Toggle menu" aria-controls="site-mobile-nav" aria-expanded={mobileOpen} onClick={() => setMobileOpen(open => !open)}>{mobileOpen ? "✕" : "☰"}</button></div>
    <nav id="site-mobile-nav" className="site-mobile-nav" aria-label="Mobile" hidden={!mobileOpen} onClick={() => setMobileOpen(false)}>{nav}{!me && !savedSession && <Link to="/signup">Sign up</Link>}</nav>
  </header>;
}
