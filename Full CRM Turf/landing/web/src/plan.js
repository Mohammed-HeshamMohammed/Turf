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

/** A short text for the waitlist: "3 seats · Skip tracing, The CRM · Power: Dialer · +2 × Extra phone number". */
export function summarize(selection) {
  const q = quote(selection);
  const on = q.lines.filter(l => l.level === "standard").map(l => l.name);
  const power = q.lines.filter(l => l.level === "power").map(l => l.name);
  const off = q.lines.filter(l => l.level === "off").map(l => l.name);
  return [
    `${q.seats} ${q.seats === 1 ? "seat" : "seats"}`,
    on.length ? `Standard: ${on.join(", ")}` : "",
    power.length ? `Power: ${power.join(", ")}` : "",
    off.length ? `Without: ${off.join(", ")}` : "",
    ...q.extras.map(e => `+${e.quantity} × ${e.name}`),
    `$${q.total}/month`,
  ]
    .filter(Boolean)
    .join(" · ");
}
