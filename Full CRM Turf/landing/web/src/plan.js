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

/** The six priced features. Exports, backup and security are included in every plan and are not offered one by one. */
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
  { id: "minutes", name: "Extra calling minutes", unit: "1,000 minutes", price: 20 },
  { id: "texts", name: "Extra texts", unit: "1,000 texts", price: 15 },
  { id: "numbers", name: "Extra phone number", unit: "number / month", price: 3 },
  { id: "lookups", name: "Extra number lookups", unit: "1,000 lookups", price: 10 },
  { id: "leads", name: "Extra active leads", unit: "500,000 leads", price: 10 },
  { id: "emails", name: "Extra campaign emails", unit: "5,000 emails", price: 10 },
  { id: "drafts", name: "Extra AI reply drafts", unit: "1,000 drafts", price: 10 },
];

export const clampSeats = n => Math.min(MAX_SEATS, Math.max(1, Math.round(Number(n)) || 1));

/** The price column a feature uses for this many people and this level. Power needs a team of three or more. */
function column(seats, level) {
  if (seats === 1) return "solo";
  if (seats === 2) return "duo";
  return level === "power" ? "pro" : "team";
}

/** What one feature costs per month: Duo is one price for both people; Team and Pro are per seat. */
export function featurePrice(feature, seats, level) {
  if (level === "off") return 0;
  const col = column(seats, level);
  return feature.prices[col] * (seats >= 3 ? seats : 1);
}

/**
 * selection: { seats, levels: { [featureId]: "off" | "standard" | "power" }, addons: { [addonId]: quantity } }
 * Returns the monthly total, the line items, and the price of the ready-made plan with every feature switched on.
 */
export function quote(selection) {
  const seats = clampSeats(selection.seats);
  const lines = BUILDER_FEATURES.map(f => {
    const level = seats < 3 && selection.levels[f.id] === "power" ? "standard" : selection.levels[f.id] || "off";
    return { id: f.id, name: f.name, level, price: featurePrice(f, seats, level) };
  });
  const extras = ADDONS.map(a => ({ ...a, quantity: Math.max(0, Math.floor(selection.addons?.[a.id] || 0)) }))
    .filter(a => a.quantity > 0)
    .map(a => ({ ...a, total: a.price * a.quantity }));
  const features = lines.reduce((sum, l) => sum + l.price, 0);
  const total = features + extras.reduce((sum, e) => sum + e.total, 0);
  const readyMade = BUILDER_FEATURES.reduce((sum, f) => sum + featurePrice(f, seats, "standard"), 0);
  return { seats, lines, extras, total, readyMade, saving: Math.max(0, readyMade - features) };
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

const pick = (seats, levels) => ({
  seats,
  levels: Object.fromEntries(BUILDER_FEATURES.map(f => [f.id, levels[f.id] || "off"])),
  addons: {},
});

/**
 * More ready-made plans for how people actually work. Each is only a starting point: the price is the sum of the
 * features switched on (the same draft prices as the builder), and "Customize" opens it in the builder.
 */
export const MORE_PLANS = [
  { id: "cleaner", name: "List Cleaner", who: "1 person who only cleans lists", text: "Skip tracing alone: rank the numbers and find the best one to call. Works offline.", selection: pick(1, { "skip-tracing": "standard" }) },
  { id: "data-desk", name: "Data Desk", who: "1 researcher", text: "Import, skip trace and map every list, without paying for calling or campaigns.", selection: pick(1, { "importing-lists": "standard", "skip-tracing": "standard", "leads-map": "standard" }) },
  { id: "starter-pipeline", name: "Starter Pipeline", who: "1 person starting out", text: "Bring your own numbers: import lists, see them on a map and track deals in the CRM.", selection: pick(1, { "importing-lists": "standard", "the-crm": "standard", "leads-map": "standard" }) },
  { id: "caller", name: "Caller", who: "1 person who lives on the phone", text: "The dialer with the CRM beside it, for working lists someone else prepared.", selection: pick(1, { "dialer-and-sms": "standard", "the-crm": "standard" }) },
  { id: "lists-to-dials", name: "Lists to Dials", who: "1 person, list to call", text: "Import, skip trace and call from one place, with no CRM or campaigns to pay for.", selection: pick(1, { "importing-lists": "standard", "skip-tracing": "standard", "dialer-and-sms": "standard" }) },
  { id: "campaign-studio", name: "Campaign Studio", who: "1 person who sells by email and text", text: "Import lists and run AI campaigns, with the CRM catching every reply.", selection: pick(1, { "importing-lists": "standard", "ai-campaigns": "standard", "the-crm": "standard" }) },
  { id: "lean-partners", name: "Lean Partners", who: "Exactly 2 partners", text: "Two people, the core loop only: import, skip trace, the CRM and the map.", selection: pick(2, { "importing-lists": "standard", "skip-tracing": "standard", "the-crm": "standard", "leads-map": "standard" }) },
  { id: "call-floor", name: "Call Floor", who: "5 callers and closers", text: "A calling team: lists, skip tracing, the dialer and the CRM for everyone, with roles.", selection: pick(5, { "importing-lists": "standard", "skip-tracing": "standard", "dialer-and-sms": "standard", "the-crm": "standard" }) },
  { id: "power-callers", name: "Power Callers", who: "3 callers who dial all day", text: "Multi-line dialing with voicemail drop, backed by skip tracing and the CRM.", selection: pick(3, { "importing-lists": "standard", "skip-tracing": "standard", "dialer-and-sms": "power", "the-crm": "standard" }) },
];

/** A short text for the waitlist: "3 seats · Skip tracing, The CRM · Power: Dialer · +2 × Extra phone number". */
export function summarize(selection, name = "") {
  const q = quote(selection);
  const on = q.lines.filter(l => l.level === "standard").map(l => l.name);
  const power = q.lines.filter(l => l.level === "power").map(l => l.name);
  const off = q.lines.filter(l => l.level === "off").map(l => l.name);
  return [
    name ? `${name} (${q.seats} ${q.seats === 1 ? "seat" : "seats"})` : `${q.seats} ${q.seats === 1 ? "seat" : "seats"}`,
    on.length ? `Standard: ${on.join(", ")}` : "",
    power.length ? `Power: ${power.join(", ")}` : "",
    off.length ? `Without: ${off.join(", ")}` : "",
    ...q.extras.map(e => `+${e.quantity} × ${e.name}`),
    `$${q.total}/month`,
  ]
    .filter(Boolean)
    .join(" · ");
}
