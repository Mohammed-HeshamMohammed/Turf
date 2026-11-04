import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Link } from "../../nav.tsx";

interface NavLink { label: string; href: string }
interface Partner { logoUrl: string; href: string; name: string }

interface ResponsiveHeroBannerProps {
  header?: ReactNode;
  logoUrl?: string;
  backgroundImageUrl?: string;
  previewImageUrl?: string;
  previewAlt?: string;
  navLinks?: NavLink[];
  ctaButtonText?: string;
  ctaButtonHref?: string;
  badgeLabel?: string;
  badgeText?: string;
  title: string;
  titleLine2?: string;
  description: string;
  primaryButtonText?: string;
  primaryButtonHref?: string;
  secondaryButtonText?: string;
  secondaryButtonHref?: string;
  partnersTitle?: string;
  partners?: Partner[];
}

/** The supplied hero pattern, using Caller Whale's own routes and assets. */
export function ResponsiveHeroBanner({
  header,
  logoUrl = "/favicon.svg",
  backgroundImageUrl,
  previewImageUrl,
  previewAlt = "",
  navLinks = [],
  ctaButtonText,
  ctaButtonHref,
  badgeLabel,
  badgeText,
  title,
  titleLine2,
  description,
  primaryButtonText,
  primaryButtonHref,
  secondaryButtonText,
  secondaryButtonHref,
  partnersTitle,
  partners = [],
}: ResponsiveHeroBannerProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const frame = useRef<number | null>(null);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const moveBackground = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    const section = event.currentTarget;
    const rect = section.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      section.style.setProperty("--pointer-x", `${x * 100}%`);
      section.style.setProperty("--pointer-y", `${y * 100}%`);
      section.style.setProperty("--drift-x", `${(0.5 - x) * 18}px`);
      section.style.setProperty("--drift-y", `${(0.5 - y) * 18}px`);
      frame.current = null;
    });
  };
  const resetBackground = (event: PointerEvent<HTMLElement>) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const section = event.currentTarget;
    section.style.setProperty("--pointer-x", "50%");
    section.style.setProperty("--pointer-y", "50%");
    section.style.setProperty("--drift-x", "0px");
    section.style.setProperty("--drift-y", "0px");
  };
  return <section className="hero-banner" onPointerMove={moveBackground} onPointerLeave={resetBackground}>
    {backgroundImageUrl && <img className="hero-banner-bg" src={backgroundImageUrl} alt="" aria-hidden="true" />}
    {header || <header className="hero-banner-nav">
      <Link className="hero-brand" to="/"><img src={logoUrl} alt="" width="34" height="34" />Caller Whale</Link>
      <nav className="hero-nav-desktop" aria-label="Main">
        {navLinks.map(link => <Link key={link.href} to={link.href}>{link.label}</Link>)}
        {ctaButtonText && ctaButtonHref && <Link className="hero-nav-cta" to={ctaButtonHref}>{ctaButtonText} <span aria-hidden="true">↗</span></Link>}
      </nav>
      <button type="button" className="hero-menu-toggle" onClick={() => setMobileMenuOpen(open => !open)} aria-expanded={mobileMenuOpen} aria-controls="hero-mobile-nav" aria-label="Toggle menu">
        <span aria-hidden="true">{mobileMenuOpen ? "✕" : "☰"}</span>
      </button>
      <nav id="hero-mobile-nav" className="hero-nav-mobile" aria-label="Mobile" hidden={!mobileMenuOpen}>
        {navLinks.map(link => <Link key={link.href} to={link.href} onClick={() => setMobileMenuOpen(false)}>{link.label}</Link>)}
        {ctaButtonText && ctaButtonHref && <Link to={ctaButtonHref} onClick={() => setMobileMenuOpen(false)}>{ctaButtonText}</Link>}
      </nav>
    </header>}
    <div className="hero-banner-copy">
      {(badgeLabel || badgeText) && <span className="hero-kicker">{badgeLabel && <span>{badgeLabel}</span>}{badgeText}</span>}
      <h1>{title}{titleLine2 && <><br />{titleLine2}</>}</h1>
      <p>{description}</p>
      <div className="actions">
        {primaryButtonText && primaryButtonHref && <Link className="button primary" to={primaryButtonHref}>{primaryButtonText}<span aria-hidden="true">↗</span></Link>}
        {secondaryButtonText && secondaryButtonHref && <Link className="button hero-secondary" to={secondaryButtonHref}>{secondaryButtonText}<span aria-hidden="true">→</span></Link>}
      </div>
    </div>
    {previewImageUrl && <figure className="hero-preview"><img src={previewImageUrl} alt={previewAlt} width="1280" height="800" fetchPriority="high" /></figure>}
    {partners.length > 0 && <div className="hero-partners"><p>{partnersTitle}</p><div>{partners.map(partner => <a key={partner.href} href={partner.href} aria-label={partner.name}><img src={partner.logoUrl} alt={partner.name} /></a>)}</div></div>}
  </section>;
}

export default ResponsiveHeroBanner;
