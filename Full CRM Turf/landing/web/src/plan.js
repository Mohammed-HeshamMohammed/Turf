// The plan builder's arithmetic. Prices are the draft per-feature prices in content.js (docs/plans/README.md).
import { priceRows } from "./content.js";

// priceRows[i].values are [Free trial, Solo, Duo, Team, Pro]. Solo is 1 person, Duo is exactly 2 (one price for both),
// Team starts at 3 people (per seat), and Pro is a Team with the power version of each feature (per seat).
const SOLO = 1;
const DUO = 2;
const TEAM = 3;
const PRO = 4;

export const MAX_SEATS = 50;

const dollars = text => (text.startsWith("$") ? Number(text.slice(1)) : 0);

/** The five priced features. The CRM, exports, backup and restore, and accounts and security are included in every plan. */
export const BUILDER_FEATURES = priceRows
  .filter(r => r.values[SOLO].startsWith("$"))
  .map(r => ({
    id: r.feature.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, ""),
    name: r.feature,
    prices: { solo: dollars(r.values[SOLO]), duo: dollars(r.values[DUO]), team: dollars(r.values[TEAM]), pro: dollars(r.values[PRO]) },
    limits: { solo: r.limits[SOLO], duo: r.limits[DUO], team: r.limits[TEAM], pro: r.limits[PRO] },
  }));

// Extras from the "Add-ons" tables in docs/features. Quantities are whole units.
export const ADDONS = [
  { id: "texts", name: "Extra texts", unit: "1,000 texts", price: 15 },
  { id: "numbers", name: "Extra phone number", unit: "number / month", price: 1 }, // about what a number costs Turf, passed on
  { id: "lookups", name: "Extra number lookups", unit: "1,000 lookups", price: 10 },
  { id: "leads", name: "Extra active leads", unit: "500,000 leads", price: 10 },
  { id: "emails", name: "Extra campaign emails", unit: "1,000 emails", price: 2 },
  { id: "drafts", name: "Extra AI reply drafts", unit: "1,000 drafts", price: 10 },
];

/** Features whose volume the buyer flexes right in their row, in steps of 1,000 priced as the matching add-on. */
export const FLEX = {
  "dialer-and-sms": { addon: "texts", ask: "Need more texts?" },
  "ai-campaigns": { addon: "emails", ask: "Need more campaign emails?" },
};

/**
 * The all-in price: what a person at most pays for the priced features together, whatever is switched on. Without it,
 * everything for one person would be $295; with it, one person never pays more than $199. It is per person, so a
 * team's cap grows with the team. Duo is one price for both people. Power teams have their own, higher cap.
 */
export const ALL_IN = { solo: 199, duo: 320, team: 163, pro: 334 };

export function allInCap(seats, power) {
  if (seats === 1) return ALL_IN.solo;
  if (seats === 2) return ALL_IN.duo;
  return (power ? ALL_IN.pro : ALL_IN.team) * seats;
}

export const clampSeats = n => Math.min(MAX_SEATS, Math.max(1, Math.round(Number(n)) || 1));

/**
 * The price column for the number of people who use a feature. Each feature is priced by its own head count, so an
 * owner who skip traces alone pays the one-person price for it, however many callers there are.
 */
function column(people, level) {
  if (people === 1) return "solo";
  if (people === 2) return "duo";
  return level === "power" ? "pro" : "team";
}

/** What one feature costs per month: Duo is one price for both people; Team and Pro are per person. */
export function featurePrice(feature, people, level) {
  if (level === "off") return 0;
  const col = column(people, level);
  return feature.prices[col] * (people >= 3 ? people : 1);
}

/** How many of the team use a feature: its own number, never more than the team, at least one. */
export function peopleFor(selection, featureId) {
  const seats = clampSeats(selection.seats);
  const n = Math.round(Number(selection.users?.[featureId] ?? seats)) || seats;
  return Math.min(seats, Math.max(1, n));
}

/**
 * selection: { seats, levels: { [featureId]: "off" | "standard" | "power" },
 *              users: { [featureId]: people using it (default: everyone) }, addons: { [addonId]: quantity } }
 * Returns the monthly total (the features at their list prices, held to the all-in cap, plus extras), the line items, the
 * list price before the cap, and the price of the ready-made plan with every feature switched on for the whole team.
 */
export function quote(selection) {
  const seats = clampSeats(selection.seats);
  const lines = BUILDER_FEATURES.map(f => {
    const people = peopleFor(selection, f.id);
    const level = people < 3 && selection.levels[f.id] === "power" ? "standard" : selection.levels[f.id] || "off";
    return { id: f.id, name: f.name, level, people, price: featurePrice(f, people, level) };
  });
  const extras = ADDONS.map(a => ({ ...a, quantity: Math.max(0, Math.floor(selection.addons?.[a.id] || 0)) }))
    .filter(a => a.quantity > 0)
    .map(a => ({ ...a, total: a.price * a.quantity }));
  const listPrice = lines.reduce((sum, l) => sum + l.price, 0);
  const cap = allInCap(seats, lines.some(l => l.level === "power"));
  const features = Math.min(listPrice, cap);
  const total = features + extras.reduce((sum, e) => sum + e.total, 0);
  const allStandard = BUILDER_FEATURES.reduce((sum, f) => sum + featurePrice(f, seats, "standard"), 0);
  const readyMade = Math.min(allStandard, allInCap(seats, false));
  return {
    seats, lines, extras, total, readyMade, saving: Math.max(0, readyMade - features),
    listPrice, cap, features, bundleSaving: listPrice - features,
  };
}

/** A starting point that matches a ready-made plan. */
export function preset(id) {
  const all = level => Object.fromEntries(BUILDER_FEATURES.map(f => [f.id, level]));
  return {
    solo: { seats: 1, levels: all("standard"), addons: {} },
    duo: { seats: 2, levels: all("standard"), addons: {} },
    team: { seats: 3, levels: all("standard"), addons: {} },
    pro: { seats: 3, levels: all("power"), addons: {} },
  }[id];
}

// users: how many people use a feature, when not the whole team (for example one owner skip traces for five callers).
const pick = (seats, levels, users = {}) => ({
  seats,
  levels: Object.fromEntries(BUILDER_FEATURES.map(f => [f.id, levels[f.id] || "off"])),
  users: Object.fromEntries(BUILDER_FEATURES.map(f => [f.id, users[f.id] ?? seats])),
  addons: {},
});

/**
 * More ready-made plans for how people actually work. Each is only a starting point: the price is the sum of the
 * features switched on (the same draft prices as the builder), and "Customize" opens it in the builder.
 */
export const MORE_PLANS = [
  { id: "cleaner", name: "List Cleaner", who: "1 person who only cleans lists", text: "Skip tracing alone: rank the numbers and find the best one to call. Works offline.", selection: pick(1, { "skip-tracing": "standard" }) },
  { id: "data-desk", name: "Data Desk", who: "1 researcher", text: "Import, skip trace and map every list, without paying for calling or campaigns.", selection: pick(1, { "importing-lists": "standard", "skip-tracing": "standard", "leads-map": "standard" }) },
  { id: "starter-pipeline", name: "Starter Pipeline", who: "1 person starting out", text: "Bring your own numbers: import lists, see them on a map and track deals in the CRM.", selection: pick(1, { "importing-lists": "standard", "leads-map": "standard" }) },
  { id: "caller", name: "Caller", who: "1 person who lives on the phone", text: "The dialer with the CRM beside it, for working lists someone else prepared.", selection: pick(1, { "dialer-and-sms": "standard" }) },
  { id: "lists-to-dials", name: "Lists to Dials", who: "1 person, list to call", text: "Import, skip trace and call from one place, with no CRM or campaigns to pay for.", selection: pick(1, { "importing-lists": "standard", "skip-tracing": "standard", "dialer-and-sms": "standard" }) },
  { id: "campaign-studio", name: "Campaign Studio", who: "1 person who sells by email and text", text: "Import lists and run AI campaigns, with the CRM catching every reply.", selection: pick(1, { "importing-lists": "standard", "ai-campaigns": "standard" }) },
  { id: "lean-partners", name: "Lean Partners", who: "Exactly 2 partners", text: "Two people, the core loop only: import, skip trace, the CRM and the map.", selection: pick(2, { "importing-lists": "standard", "skip-tracing": "standard", "leads-map": "standard" }) },
  { id: "owner-callers", name: "Owner and Callers", who: "An owner who preps lists, and 4 callers", text: "The owner imports and skip traces alone, and four callers pay only for the dialer. The CRM is included for all five.", selection: pick(5, { "importing-lists": "standard", "skip-tracing": "standard", "dialer-and-sms": "standard" }, { "importing-lists": 1, "skip-tracing": 1, "dialer-and-sms": 4 }) },
  { id: "call-floor", name: "Call Floor", who: "5 callers and closers", text: "A calling team: lists, skip tracing, the dialer and the CRM for everyone, with roles.", selection: pick(5, { "importing-lists": "standard", "skip-tracing": "standard", "dialer-and-sms": "standard" }) },
  { id: "power-callers", name: "Power Callers", who: "3 callers who dial all day", text: "Multi-line dialing with voicemail drop, backed by skip tracing and the CRM.", selection: pick(3, { "importing-lists": "standard", "skip-tracing": "standard", "dialer-and-sms": "power" }) },
];

/** What a ready-made tier costs and what the same features would cost one by one. Team and Pro are per person, for a team of three. */
export function tierPrice(id) {
  if (id === "trial") return { price: 0, list: 0, from: null };
  const q = quote(preset(id));
  const perSeat = id === "team" || id === "pro";
  return perSeat
    ? { price: q.total / q.seats, list: q.listPrice / q.seats, from: q.total }
    : { price: q.total, list: q.listPrice, from: null };
}

/** A short text for the waitlist: "Call Floor (5 seats) · Standard: Skip tracing (1 person), The CRM · +2 × Extra phone number". */
export function summarize(selection, name = "") {
  const q = quote(selection);
  const label = l => (l.people === q.seats ? l.name : `${l.name} (${l.people} ${l.people === 1 ? "person" : "people"})`);
  const on = q.lines.filter(l => l.level === "standard").map(label);
  const power = q.lines.filter(l => l.level === "power").map(label);
  const off = q.lines.filter(l => l.level === "off").map(l => l.name);
  const team = `${q.seats} ${q.seats === 1 ? "seat" : "seats"}`;
  return [
    name ? `${name} (${team})` : team,
    on.length ? `Standard: ${on.join(", ")}` : "",
    power.length ? `Power: ${power.join(", ")}` : "",
    off.length ? `Without: ${off.join(", ")}` : "",
    ...q.extras.map(e => `+${e.quantity} × ${e.name}`),
    `$${q.total}/month`,
  ]
    .filter(Boolean)
    .join(" · ");
}
