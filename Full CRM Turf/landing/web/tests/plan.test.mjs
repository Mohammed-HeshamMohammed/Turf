import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDONS, BUILDER_FEATURES, MORE_PLANS, clampSeats, peopleFor, preset, quote, summarize } from "../src/plan.js";

test("the ready-made plans add up to the drafted totals", () => {
  assert.equal(quote(preset("solo")).total, 344);
  assert.equal(quote(preset("duo")).total, 554);
  assert.equal(quote(preset("team")).total, 858); // 3 seats x $286
  assert.equal(quote(preset("pro")).total, 1662); // 3 seats x $554
});

test("six features are offered one by one", () => {
  assert.deepEqual(BUILDER_FEATURES.map(f => f.name), [
    "Importing lists", "Skip tracing", "Dialer and SMS", "Leads map", "The CRM", "AI campaigns",
  ]);
});

test("dropping features lowers the price and shows the saving against the ready-made plan", () => {
  const s = preset("solo");
  s.levels["ai-campaigns"] = "off";
  s.levels["leads-map"] = "off";
  const q = quote(s);
  assert.equal(q.total, 344 - 49 - 19);
  assert.equal(q.saving, 68);
  assert.equal(q.readyMade, 344);
});

test("extras are added at their own price", () => {
  const s = preset("solo");
  s.addons = { numbers: 2, minutes: 1 };
  assert.equal(quote(s).total, 344 + 6 + 20);
});

test("power needs three or more people and falls back to standard below that", () => {
  const s = preset("pro");
  s.seats = 2;
  assert.equal(quote(s).total, 554);
  s.seats = 4;
  assert.equal(quote(s).total, 554 * 4);
});

test("seats are kept between 1 and 50", () => {
  assert.equal(clampSeats(0), 1);
  assert.equal(clampSeats("abc"), 1);
  assert.equal(clampSeats(999), 50);
  assert.equal(clampSeats(3.4), 3);
});

test("the summary names what is in and out, and the total", () => {
  const s = preset("duo");
  s.levels["the-crm"] = "off";
  s.addons = { texts: 1 };
  const text = summarize(s);
  assert.match(text, /^2 seats/);
  assert.match(text, /Without: The CRM/);
  assert.match(text, /\+1 × Extra texts/);
  assert.match(text, /\$490\/month$/); // 554 - 79 (The CRM) + 15 (1,000 texts)
});

test("every add-on has a positive price", () => {
  for (const a of ADDONS) assert.ok(a.price > 0, a.id);
});

test("the more plans are sums of the features they name", () => {
  const price = id => quote(MORE_PLANS.find(p => p.id === id).selection).total;
  assert.equal(price("cleaner"), 79);
  assert.equal(price("data-desk"), 49 + 79 + 19);
  assert.equal(price("starter-pipeline"), 49 + 49 + 19);
  assert.equal(price("caller"), 99 + 49);
  assert.equal(price("lists-to-dials"), 49 + 79 + 99);
  assert.equal(price("campaign-studio"), 49 + 49 + 49);
  assert.equal(price("lean-partners"), 69 + 119 + 79 + 29);
  assert.equal(price("call-floor"), (39 + 59 + 89 + 45) * 5);
  assert.equal(price("power-callers"), (39 + 59 + 239 + 45) * 3);
});

test("every more plan without Power is cheaper than every feature at Standard for the same people", () => {
  for (const p of MORE_PLANS) {
    const q = quote(p.selection);
    if (!q.lines.some(l => l.level === "power")) assert.ok(q.total < q.readyMade, p.id);
    assert.ok(q.lines.some(l => l.level !== "off"), p.id);
  }
});

test("a named plan leads the waitlist summary", () => {
  assert.match(summarize(MORE_PLANS[0].selection, "List Cleaner"), /^List Cleaner \(1 seat\) · Standard: Skip tracing/);
});

test("a feature used by one person is priced for one person, not for the whole team", () => {
  // An owner skip traces alone; four callers only use the dialer; all five are in the CRM.
  const sel = MORE_PLANS.find(p => p.id === "owner-callers").selection;
  const q = quote(sel);
  const line = id => q.lines.find(l => l.id === id);
  assert.equal(line("skip-tracing").price, 79); // one person, the Solo price, not 5 x $59
  assert.equal(line("importing-lists").price, 49);
  assert.equal(line("dialer-and-sms").price, 89 * 4);
  assert.equal(line("the-crm").price, 45 * 5);
  assert.equal(q.total, 79 + 49 + 356 + 225);
  assert.ok(q.total < (39 + 59 + 89 + 45) * 5, "cheaper than giving all five every feature");
});

test("two people on a feature get the Duo price, and Power needs three on that feature", () => {
  const sel = preset("pro");
  sel.seats = 5;
  sel.users = { "skip-tracing": 2, "dialer-and-sms": 2 };
  const q = quote(sel);
  assert.equal(q.lines.find(l => l.id === "skip-tracing").price, 119);
  assert.equal(q.lines.find(l => l.id === "skip-tracing").level, "standard"); // Power needs 3 or more on the feature
  assert.equal(q.lines.find(l => l.id === "the-crm").price, 59 * 5); // everyone else still at Power
});

test("people on a feature are kept between one and the team size", () => {
  const sel = preset("team");
  sel.users = { "the-crm": 99, "leads-map": 0 };
  assert.equal(peopleFor(sel, "the-crm"), 3);
  assert.equal(peopleFor(sel, "leads-map"), 3); // 0 means "not set", so the whole team
});

test("the summary says which features only some people use", () => {
  const sel = MORE_PLANS.find(p => p.id === "owner-callers").selection;
  assert.match(summarize(sel, "Owner and Callers"), /Skip tracing \(1 person\)/);
  assert.match(summarize(sel), /Dialer and SMS \(4 people\)/);
});
