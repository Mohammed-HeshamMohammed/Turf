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

export function SiteHeader({ path, me, onSignOut }: { path: string; me: Me | null | undefined; onSignOut: () => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [detached, setDetached] = useState(false);
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
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && accountMenu.current) accountMenu.current.open = false; };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  const nav = links.map(link => <Link key={link.to} to={link.to} aria-current={path === link.to || (link.to === "/features" && path.startsWith("/features/")) ? "page" : undefined}>{link.label}</Link>);
  const account = me === undefined ? null : me ? <details className="account-menu" ref={accountMenu}>
    <summary aria-label={`Account menu for ${me.name || me.email}`} title="Account menu"><span className="avatar" aria-hidden="true">{(me.name || me.email || "C").trim().charAt(0).toUpperCase()}</span></summary>
    <div className="account-popover"><span className="account-identity">{me.name || "Your account"}<small>{me.email}</small></span><a href="https://app.callerwhale.com/">Dashboard</a><Link to="/account" onClick={() => { if (accountMenu.current) accountMenu.current.open = false; }}>Your profile</Link><button type="button" onClick={() => { if (accountMenu.current) accountMenu.current.open = false; onSignOut(); }}>Sign out</button></div>
  </details> : <div className="site-auth"><Link to="/signin">Sign in</Link><Link className="site-signup" to="/signup">Sign up</Link></div>;
  return <header className={`site-header${path === "/" ? detached ? " is-detached" : " is-on-hero" : ""}`}>
    <Link className="site-brand" to="/"><img src="/favicon.svg" alt="" width="34" height="34" />Caller Whale</Link>
    <nav className="site-nav" aria-label="Main">{nav}</nav>
    <div className="site-header-end">{account}<button type="button" className="site-menu-toggle" aria-label="Toggle menu" aria-controls="site-mobile-nav" aria-expanded={mobileOpen} onClick={() => setMobileOpen(open => !open)}>{mobileOpen ? "✕" : "☰"}</button></div>
    <nav id="site-mobile-nav" className="site-mobile-nav" aria-label="Mobile" hidden={!mobileOpen} onClick={() => setMobileOpen(false)}>{nav}{me === null && <Link to="/signup">Sign up</Link>}</nav>
  </header>;
}
