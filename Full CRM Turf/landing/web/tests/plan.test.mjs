import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDONS, BUILDER_FEATURES, clampSeats, preset, quote, summarize } from "../src/plan.js";

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
