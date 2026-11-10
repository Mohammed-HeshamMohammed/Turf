import { Link } from "../../nav.tsx";

export function SiteFooter({ compact = false }: { compact?: boolean }) {
  if (compact) return <footer className="site-footer site-footer-compact">
    <span>© {new Date().getFullYear()} Caller Whale</span>
    <nav aria-label="Dashboard footer"><Link to="/contact">Contact</Link><Link to="/privacy">Privacy</Link><Link to="/remove-my-information">Remove my information</Link><Link to="/terms">Terms</Link></nav>
  </footer>;
  return <footer className="site-footer">
    <div className="footer-top">
      <div className="footer-about"><Link className="footer-brand" to="/"><img src="/favicon.svg" alt="" width="34" height="34" />Caller Whale</Link><p>Keep your leads, calls and next steps together in one workspace.</p><Link className="footer-cta" to="/pricing">Build your plan <span aria-hidden="true">↗</span></Link></div>
      <nav aria-label="Explore"><h2>Explore</h2><Link to="/features">Features</Link><Link to="/why-caller-whale">Why Caller Whale</Link><Link to="/pricing">Pricing</Link></nav>
      <nav aria-label="Company"><h2>Company</h2><Link to="/security">Security</Link><Link to="/contact">Contact</Link><Link to="/remove-my-information">Remove my information</Link><Link to="/signin">Sign in</Link></nav>
      <nav aria-label="Legal"><h2>Legal</h2><Link to="/privacy">Privacy draft</Link><Link to="/terms">Terms draft</Link></nav>
    </div>
    <div className="footer-bottom"><span>© {new Date().getFullYear()} Caller Whale</span><span>Built for lead teams.</span></div>
  </footer>;
}
