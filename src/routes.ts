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
  { path: "/why-caller-whale", key: "why", title: "Why Caller Whale · One workspace for lead teams", description: "Keep lists, lead records, calls, handoffs and reports together in one workspace.", indexable: true, sitemap: true },
  ...features.map(feature => ({ path: `/features/${feature.slug}`, key: `feature:${feature.slug}`, title: `${feature.title} · Caller Whale`, description: feature.short, indexable: true, sitemap: true })),
  { path: "/security", key: "security", title: "Security · Caller Whale", description: "How Caller Whale protects accounts and data, and what is still in preview.", indexable: true, sitemap: true },
  { path: "/contact", key: "contact", title: "Contact · Caller Whale", description: "Send the Caller Whale team a message.", indexable: true, sitemap: true },
  { path: "/remove-my-information", key: "remove", title: "Remove my information · Caller Whale", description: "Ask Caller Whale to remove a phone number or an email address from what it has learned.", indexable: true, sitemap: true },
  { path: "/privacy", key: "privacy", title: "Privacy notice · Caller Whale", description: "What Caller Whale handles about you, why, who sees it, how long it is kept and your choices.", indexable: true, sitemap: true },
  { path: "/dpa", key: "dpa", title: "Data Processing Addendum · Caller Whale", description: "How Caller Whale handles the lists and records customers add, including the learning copy.", indexable: true, sitemap: true },
  { path: "/acceptable-use", key: "acceptable-use", title: "Acceptable Use and Calling Policy · Caller Whale", description: "What Caller Whale expects when customers call, text and email.", indexable: true, sitemap: true },
  { path: "/terms", key: "terms", title: "Terms of Service · Caller Whale", description: "The agreement for using Caller Whale.", indexable: true, sitemap: true },
  { path: "/signin", key: "signin", title: "Sign in · Caller Whale", description: "Sign in to your Caller Whale account.", indexable: false, sitemap: false },
  { path: "/signup", key: "signup", title: "Create your account · Caller Whale", description: "Create your Caller Whale account.", indexable: false, sitemap: false },
  { path: "/forgot", key: "forgot", title: "Reset your password · Caller Whale", description: "Reset your Caller Whale password.", indexable: false, sitemap: false },
  { path: "/account", key: "account", title: "Settings · Caller Whale", description: "Your Caller Whale settings.", indexable: false, sitemap: false },
  { path: "/profile", key: "profile", title: "Profile · Caller Whale", description: "Your Caller Whale profile.", indexable: false, sitemap: false },
  { path: "/connect", key: "connect", title: "Connect an assistant · Caller Whale", description: "Allow an AI assistant to use your Caller Whale account.", indexable: false, sitemap: false },
  { path: "/dashboard", key: "dashboard", title: "Dashboard · Caller Whale", description: "Your Caller Whale membership and platform access.", indexable: false, sitemap: false },
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
