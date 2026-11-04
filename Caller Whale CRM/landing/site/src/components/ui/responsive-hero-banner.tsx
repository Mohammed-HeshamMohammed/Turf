import { useState } from "react";
import { Link } from "../../nav.tsx";

interface NavLink { label: string; href: string }
interface Partner { logoUrl: string; href: string; name: string }

interface ResponsiveHeroBannerProps {
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
  return <section className="hero-banner">
    {backgroundImageUrl && <img className="hero-banner-bg" src={backgroundImageUrl} alt="" aria-hidden="true" />}
    <header className="hero-banner-nav">
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
    </header>
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
