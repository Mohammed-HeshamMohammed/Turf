import { useCallback, useEffect, useState } from "react";
import { accountPages } from "./content.js";
import { Footer, GetStarted, Header, InviteOnly, Waitlist } from "./components.jsx";
import { Compare, Contact, Features, Home, Legal, NotFound, Pricing, Security, legalPages } from "./pages.jsx";
import { Dashboard, SignIn, SignUp, VerifyEmail } from "./AccountPages.jsx";
import { SessionProvider } from "./session.jsx";
import { MotionProvider } from "./motion.jsx";

import { PAGE_PATHS, routeForPath } from "./routes.js";
import { applyMetadata } from "./metadata.js";
export { PAGE_PATHS } from "./routes.js";
export const pageFor = pathname => routeForPath(pathname).key;

function scrollToHash(hash) {
  let id = "";
  try { id = decodeURIComponent(hash.slice(1)); } catch { /* Malformed fragments do not break navigation. */ }
  const target = id && document.getElementById(id);
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

/** The page for the address bar, with in-site links handled without reloading (and still real links without scripts). */
function useRoute(initialPath) {
  const [pathname, setPathname] = useState(initialPath);
  const go = useCallback(href => {
    const url = new URL(href, window.location.origin);
    const changed = url.pathname !== window.location.pathname;
    window.history.pushState({}, "", url.pathname + url.search + url.hash);
    setPathname(url.pathname);
    requestAnimationFrame(() => {
      scrollToHash(url.hash);
      if (changed && !url.hash) document.getElementById("main")?.focus({ preventScroll: true });
    });
  }, []);
  useEffect(() => {
    if (window.location.hash) requestAnimationFrame(() => scrollToHash(window.location.hash));
    const onPop = () => { setPathname(window.location.pathname); requestAnimationFrame(() => scrollToHash(window.location.hash)); };
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
    applyMetadata(page);
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
    verify: <VerifyEmail />,
  }[page];
  const marketing = !legalPages.includes(page) && !accountPages.includes(page) && page !== "notfound";
  return (
    <MotionProvider><SessionProvider>
      <a className="skip-link" href="#main">Skip to content</a>
      <Header route={page} />
      <main id="main" tabIndex={-1} key={page}>
        {body}
        {marketing && page !== "home" && <InviteOnly />}
        {marketing && <Waitlist tier={choice.tier} plan={choice.plan} setTier={onPick} />}
      </main>
      <Footer />
      {marketing && <GetStarted route={page} />}
    </SessionProvider></MotionProvider>
  );
}
