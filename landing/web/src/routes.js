import { pageMeta } from "./content.js";

// One registry drives routing, metadata, prerendering and public discovery.
export const routes = [
  { path: "/", key: "home", label: "Home", indexable: true, sitemap: true },
  {
    path: "/features",
    key: "features",
    label: "Features",
    indexable: true,
    sitemap: true,
  },
  {
    path: "/pricing",
    key: "pricing",
    label: "Pricing",
    indexable: true,
    sitemap: true,
  },
  {
    path: "/compare",
    key: "compare",
    label: "Why Caller Whale",
    indexable: true,
    sitemap: true,
  },
  {
    path: "/security",
    key: "security",
    label: "Security",
    indexable: true,
    sitemap: true,
  },
  {
    path: "/contact",
    key: "contact",
    label: "Contact",
    indexable: true,
    sitemap: true,
  },
  // These public drafts remain readable/indexable, but are not advertised in the sitemap until reviewed.
  {
    path: "/privacy",
    key: "privacy",
    label: "Privacy",
    indexable: true,
    sitemap: false,
  },
  {
    path: "/terms",
    key: "terms",
    label: "Terms",
    indexable: true,
    sitemap: false,
  },
  ...[
    ["/signin", "signin", "Sign in"],
    ["/signup", "signup", "Sign up"],
    ["/dashboard", "dashboard", "Dashboard"],
    ["/verify", "verify", "Confirm email"],
  ].map(([path, key, label]) => ({
    path,
    key,
    label,
    indexable: false,
    sitemap: false,
  })),
].map((route) => ({
  ...route,
  title: pageMeta[route.key][0],
  description: pageMeta[route.key][1],
}));
export const notFoundRoute = {
  path: "/404",
  key: "notfound",
  label: "Not found",
  title: pageMeta.notfound[0],
  description: pageMeta.notfound[1],
  indexable: false,
  sitemap: false,
};
export const PAGE_PATHS = Object.fromEntries(
  routes.map((route) => [route.path, route.key]),
);
export const routeForKey = (key) =>
  routes.find((route) => route.key === key) || notFoundRoute;
export const normalizePath = (pathname) => pathname.replace(/(.)\/+$/, "$1");
export const routeForPath = (pathname) =>
  routes.find((route) => route.path === normalizePath(pathname)) ||
  notFoundRoute;
