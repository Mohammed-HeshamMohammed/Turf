import { useEffect, useState } from "react";
import { pageMeta } from "./content.js";
import { Download, Footer, Header, Waitlist } from "./components.jsx";
import { Compare, Contact, Features, Home, Legal, Pricing, Security, legalPages } from "./pages.jsx";

const PAGES = ["features", "pricing", "compare", "security", "contact", ...legalPages];

/** "#/features#map" is the Features page, scrolled to #map. A bare "#waitlist" is an anchor on the current page. */
function parseHash() {
  const hash = window.location.hash;
  if (!hash.startsWith("#/")) return { page: null, anchor: hash.slice(1) };
  const [path, anchor = ""] = hash.slice(2).split("#");
  return { page: PAGES.includes(path) ? path : "home", anchor };
}

function useRoute() {
  const [page, setPage] = useState(() => parseHash().page || "home");
  const [anchor, setAnchor] = useState(() => parseHash().anchor);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => {
      const next = parseHash();
      if (next.page) setPage(next.page); // a bare anchor keeps the current page
      setAnchor(next.anchor);
      setTick(t => t + 1);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    const [title, description] = pageMeta[page];
    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", description);
  }, [page]);
  // After the page renders: go to its anchor, or to the top.
  useEffect(() => {
    requestAnimationFrame(() => {
      const target = anchor && document.getElementById(anchor);
      if (target) target.scrollIntoView();
      else if (tick > 0) window.scrollTo(0, 0);
    });
  }, [page, anchor, tick]);
  return page;
}

export function App() {
  const [tier, setTier] = useState("");
  const page = useRoute();
  const body = {
    home: <Home onPick={setTier} />,
    features: <Features />,
    pricing: <Pricing onPick={setTier} />,
    compare: <Compare />,
    security: <Security />,
    contact: <Contact />,
    privacy: <Legal page="privacy" />,
    terms: <Legal page="terms" />,
  }[page];
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <Header route={page} />
      <main id="main" tabIndex={-1}>
        {body}
        <Download />
        <Waitlist tier={tier} setTier={setTier} />
      </main>
      <Footer />
    </>
  );
}
