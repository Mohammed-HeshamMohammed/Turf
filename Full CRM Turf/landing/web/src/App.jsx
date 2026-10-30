import { useCallback, useEffect, useState } from "react";
import { accountPages, pageMeta } from "./content.js";
import { Footer, Header, InviteOnly, Waitlist } from "./components.jsx";
import { Compare, Contact, Features, Home, Legal, NotFound, Pricing, Security, legalPages } from "./pages.jsx";
import { Dashboard, SignIn, SignUp } from "./AccountPages.jsx";
import { SessionProvider } from "./session.jsx";

export const PAGE_PATHS = {
  "/": "home", "/features": "features", "/pricing": "pricing", "/compare": "compare", "/security": "security", "/contact": "contact", "/privacy": "privacy",
  "/terms": "terms", "/signin": "signin", "/signup": "signup", "/dashboard": "dashboard",
};

/** "/pricing/" and "/pricing" are the same page; an unknown path is the not-found page. */
export const pageFor = pathname => PAGE_PATHS[pathname.replace(/(.)\/+$/, "$1")] || "notfound";

/** Counts a page view without cookies, addresses or any id (landing/api keeps a day, a page and a count). */
function countView(pathname) {
  if (import.meta.env?.DEV || navigator.doNotTrack === "1") return;
  fetch("/api/hit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: pathname }),
    keepalive: true,
  }).catch(() => {});
}

function scrollToHash(hash) {
  const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

/** The page for the address bar, with in-site links handled without reloading (and still real links without scripts). */
function useRoute(initialPath) {
  const [pathname, setPathname] = useState(initialPath);
  const go = useCallback(href => {
    const url = new URL(href, window.location.origin);
    window.history.pushState({}, "", url.pathname + url.search + url.hash);
    setPathname(url.pathname);
    requestAnimationFrame(() => scrollToHash(url.hash));
    countView(url.pathname);
  }, []);
  useEffect(() => {
    countView(window.location.pathname);
    if (window.location.hash) requestAnimationFrame(() => scrollToHash(window.location.hash));
    const onPop = () => setPathname(window.location.pathname);
    // A click on a link to another page of this site: keep the app, change the page. Anchors on this page stay native.
    const onClick = e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest?.("a[href]");
      if (!a || a.target || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href.startsWith("/") || href.startsWith("//")) return;
      const url = new URL(href, window.location.origin);
      if (!(url.pathname.replace(/(.)\/+$/, "$1") in PAGE_PATHS)) return;
      e.preventDefault();
      go(href);
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, [go]);
  const page = pageFor(pathname);
  useEffect(() => {
    const [title, description] = pageMeta[page] || pageMeta.notfound;
    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", description);
  }, [page]);
  return page;
}

export function App({ path = typeof window === "undefined" ? "/" : window.location.pathname }) {
  const [choice, setChoice] = useState({ tier: "", plan: "" });
  // onPick("duo") picks a ready-made plan; onPick("custom", summary) carries a plan built on the pricing page.
  const onPick = (tier, plan = "") => setChoice({ tier, plan: tier === "custom" ? plan : "" });
  const page = useRoute(path);
  const body = {
    home: <Home onPick={onPick} />,
    features: <Features />,
    pricing: <Pricing onPick={onPick} />,
    compare: <Compare />,
    security: <Security />,
    contact: <Contact />,
    privacy: <Legal page="privacy" />,
    terms: <Legal page="terms" />,
    notfound: <NotFound />,
    signin: <SignIn />,
    signup: <SignUp />,
    dashboard: <Dashboard />,
  }[page];
  const marketing = !legalPages.includes(page) && !accountPages.includes(page) && page !== "notfound";
  return (
    <SessionProvider>
      <a className="skip-link" href="#main">Skip to content</a>
      <Header route={page} />
      <main id="main" tabIndex={-1}>
        {body}
        {marketing && <InviteOnly />}
        {marketing && <Waitlist tier={choice.tier} plan={choice.plan} setTier={onPick} />}
      </main>
      <Footer />
    </SessionProvider>
  );
}
