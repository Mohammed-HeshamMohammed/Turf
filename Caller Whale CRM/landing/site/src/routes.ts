// One list drives routing, page titles and descriptions, prerendering, the sitemap and what search engines may index.
// Pages that belong to a signed-in person or are only a form are not indexed and not in the sitemap.
import { features } from "./content/features.ts";

export const routes = [
  {
    path: "/",
    key: "home",
    title: "Caller Whale · The calling workspace for lead teams",
    description: "Caller Whale keeps your leads, your calls and your team together, so the next call is always one click away.",
    indexable: true,
    sitemap: true,
  },
  {
    path: "/pricing",
    key: "pricing",
    title: "Pricing · Caller Whale",
    description: "Build your plan: switch features on and off and pay only for what you use. Draft launch prices for Solo, Duo, Team and Pro.",
    indexable: true,
    sitemap: true,
  },
  { path: "/features", key: "features", title: "Features · Caller Whale", description: "Explore Caller Whale's lead importing, calling, CRM and reporting features, with clear availability labels.", indexable: true, sitemap: true },
  ...features.map(feature => ({ path: `/features/${feature.slug}`, key: `feature:${feature.slug}`, title: `${feature.title} · Caller Whale`, description: feature.short, indexable: true, sitemap: true })),
  { path: "/security", key: "security", title: "Security · Caller Whale", description: "How Caller Whale protects accounts and data, and what is still in preview.", indexable: true, sitemap: true },
  { path: "/contact", key: "contact", title: "Contact · Caller Whale", description: "Send the Caller Whale team a message.", indexable: true, sitemap: true },
  { path: "/privacy", key: "privacy", title: "Privacy draft · Caller Whale", description: "Draft privacy notice awaiting review.", indexable: false, sitemap: false },
  { path: "/terms", key: "terms", title: "Terms draft · Caller Whale", description: "Draft terms awaiting review.", indexable: false, sitemap: false },
  { path: "/signin", key: "signin", title: "Sign in · Caller Whale", description: "Sign in to your Caller Whale account.", indexable: false, sitemap: false },
  { path: "/signup", key: "signup", title: "Create your account · Caller Whale", description: "Create your Caller Whale account.", indexable: false, sitemap: false },
  { path: "/forgot", key: "forgot", title: "Reset your password · Caller Whale", description: "Reset your Caller Whale password.", indexable: false, sitemap: false },
  { path: "/account", key: "account", title: "Your account · Caller Whale", description: "Your Caller Whale account.", indexable: false, sitemap: false },
];

export const notFoundRoute = {
  path: "/404",
  key: "notfound",
  title: "Page not found · Caller Whale",
  description: "That page does not exist.",
  indexable: false,
  sitemap: false,
};

export const cleanPath = (path: string) => path.replace(/(.)\/$/, "$1");

/** The route for a path; the not-found route for anything not on the list. */
export const routeFor = (path: string) => routes.find(route => route.path === cleanPath(path)) || notFoundRoute;
