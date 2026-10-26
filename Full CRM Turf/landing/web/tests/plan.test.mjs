import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDONS, ALL_IN, BUILDER_FEATURES, FLEX, MORE_PLANS, allInCap, tierPrice, clampSeats, peopleFor, preset, quote, summarize } from "../src/plan.js";

test("the ready-made plans come to the all-in prices", () => {
  assert.equal(quote(preset("solo")).total, 199); // $295 one by one
  assert.equal(quote(preset("duo")).total, 320); // $475 one by one
  assert.equal(quote(preset("team")).total, 489); // 3 seats x $163 ($723 one by one)
  assert.equal(quote(preset("pro")).total, 1002); // 3 seats x $334 ($1,485 one by one)
  assert.equal(quote(preset("solo")).listPrice, 295);
});

test("five features are offered one by one, and the CRM is included", () => {
  assert.deepEqual(BUILDER_FEATURES.map(f => f.name), [
    "Importing lists", "Skip tracing", "Dialer and SMS", "Leads map", "AI campaigns",
  ]);
});

test("dropping features lowers the price and shows the saving against the ready-made plan", () => {
  const s = preset("solo");
  s.levels["ai-campaigns"] = "off";
  s.levels["leads-map"] = "off";
  s.levels["dialer-and-sms"] = "off";
  const q = quote(s);
  assert.equal(q.total, 49 + 79);
  assert.equal(q.saving, 199 - 128);
  assert.equal(q.readyMade, 199);
});

test("extras are added at their own price", () => {
  const s = preset("solo");
  s.addons = { numbers: 2, emails: 2 };
  assert.equal(quote(s).total, 199 + 2 + 4); // 2 numbers at $1, 2,000 emails at $2
});

test("power needs three or more people and falls back to standard below that", () => {
  const s = preset("pro");
  s.seats = 2;
  assert.equal(quote(s).total, 320);
  s.seats = 4;
  assert.equal(quote(s).total, 334 * 4);
});

test("seats are kept between 1 and 50", () => {
  assert.equal(clampSeats(0), 1);
  assert.equal(clampSeats("abc"), 1);
  assert.equal(clampSeats(999), 50);
  assert.equal(clampSeats(3.4), 3);
});

test("the summary names what is in and out, and the total", () => {
  const s = preset("duo");
  s.levels["ai-campaigns"] = "off";
  s.addons = { texts: 1 };
  const text = summarize(s);
  assert.match(text, /^2 seats/);
  assert.match(text, /Without: AI campaigns/);
  assert.match(text, /\+1 × Extra texts/);
  assert.match(text, /\$335\/month$/); // $320 all-in cap + 15 (1,000 texts)
});

test("every add-on has a positive price", () => {
  for (const a of ADDONS) assert.ok(a.price > 0, a.id);
});

test("the more plans are sums of the features they name", () => {
  const price = id => quote(MORE_PLANS.find(p => p.id === id).selection).total;
  assert.equal(price("cleaner"), 79);
  assert.equal(price("data-desk"), 49 + 79 + 19);
  assert.equal(price("starter-pipeline"), 49 + 19);
  assert.equal(price("caller"), 99);
  assert.equal(price("lists-to-dials"), 199); // $227 one by one, held to the all-in price
  assert.equal(price("campaign-studio"), 49 + 49);
  assert.equal(price("lean-partners"), 69 + 119 + 29);
  assert.equal(price("call-floor"), 163 * 5); // $935 one by one
  assert.equal(price("power-callers"), 334 * 3); // $1,011 one by one
});

test("no more plan without Power costs more than every feature at Standard for the same people", () => {
  for (const p of MORE_PLANS) {
    const q = quote(p.selection);
    if (!q.lines.some(l => l.level === "power")) assert.ok(q.total <= q.readyMade, p.id);
    assert.ok(q.lines.some(l => l.level !== "off"), p.id);
  }
});

test("a named plan leads the waitlist summary", () => {
  assert.match(summarize(MORE_PLANS[0].selection, "List Cleaner"), /^List Cleaner \(1 seat\) · Standard: Skip tracing/);
});

test("a feature used by one person is priced for one person, not for the whole team", () => {
  // An owner imports and skip traces alone; four callers only use the dialer. The CRM is included for all five.
  const sel = MORE_PLANS.find(p => p.id === "owner-callers").selection;
  const q = quote(sel);
  const line = id => q.lines.find(l => l.id === id);
  assert.equal(line("skip-tracing").price, 79); // one person, the Solo price, not 5 x $59
  assert.equal(line("importing-lists").price, 49);
  assert.equal(line("dialer-and-sms").price, 89 * 4);
  assert.equal(q.total, 79 + 49 + 356);
  assert.ok(q.total < q.readyMade, "cheaper than giving all five every feature");
});

test("two people on a feature get the Duo price, and Power needs three on that feature", () => {
  const sel = preset("pro");
  sel.seats = 5;
  sel.users = { "skip-tracing": 2, "dialer-and-sms": 2 };
  const q = quote(sel);
  assert.equal(q.lines.find(l => l.id === "skip-tracing").price, 119);
  assert.equal(q.lines.find(l => l.id === "skip-tracing").level, "standard"); // Power needs 3 or more on the feature
  assert.equal(q.lines.find(l => l.id === "ai-campaigns").price, 79 * 5); // everyone else still at Power
});

test("people on a feature are kept between one and the team size", () => {
  const sel = preset("team");
  sel.users = { "ai-campaigns": 99, "leads-map": 0 };
  assert.equal(peopleFor(sel, "ai-campaigns"), 3);
  assert.equal(peopleFor(sel, "leads-map"), 3); // 0 means "not set", so the whole team
});

test("the summary says which features only some people use", () => {
  const sel = MORE_PLANS.find(p => p.id === "owner-callers").selection;
  assert.match(summarize(sel, "Owner and Callers"), /Skip tracing \(1 person\)/);
  assert.match(summarize(sel), /Dialer and SMS \(4 people\)/);
});

test("the CRM is a free base: it is not a priced feature and no plan charges for it", () => {
  assert.ok(!BUILDER_FEATURES.some(f => f.id === "the-crm"));
  for (const id of ["solo", "duo", "team", "pro"]) {
    assert.ok(!quote(preset(id)).lines.some(l => l.id === "the-crm"), id);
  }
});

test("calling is unlimited, so there is no minutes add-on; texts are the flexible part", () => {
  assert.ok(!ADDONS.some(a => a.id === "minutes"));
  assert.ok(ADDONS.some(a => a.id === "texts"));
  assert.equal(FLEX["dialer-and-sms"].addon, "texts");
  assert.equal(FLEX["ai-campaigns"].addon, "emails");
  assert.equal(ADDONS.find(a => a.id === "emails").price, 2); // $2 per 1,000 campaign emails
});

test("one person never pays more than the all-in price for features, however many are on", () => {
  assert.equal(ALL_IN.solo, 199);
  const s = preset("solo");
  assert.equal(quote(s).total, 199);
  assert.equal(quote(s).bundleSaving, 295 - 199);
  assert.equal(quote(s).cap, 199);
});

test("adding a feature never lowers the price, for any mix and any team size", () => {
  const ids = BUILDER_FEATURES.map(f => f.id);
  for (const seats of [1, 2, 3, 5, 12]) {
    for (let mask = 0; mask < 1 << ids.length; mask++) {
      const base = preset("solo");
      base.seats = seats;
      base.levels = Object.fromEntries(ids.map((id, i) => [id, mask & (1 << i) ? "standard" : "off"]));
      const before = quote(base).total;
      for (const [i, id] of ids.entries()) {
        if (mask & (1 << i)) continue;
        const more = { ...base, levels: { ...base.levels, [id]: "standard" } };
        assert.ok(quote(more).total >= before, `${seats} seats, adding ${id} to mask ${mask}`);
      }
    }
  }
});

test("a team's all-in price is per person and Power teams have their own", () => {
  assert.equal(allInCap(1, false), 199);
  assert.equal(allInCap(2, false), 320);
  assert.equal(allInCap(5, false), 163 * 5);
  assert.equal(allInCap(5, true), 334 * 5);
});

test("tier prices come from the same arithmetic as the builder", () => {
  assert.deepEqual(tierPrice("solo"), { price: 199, list: 295, from: null });
  assert.deepEqual(tierPrice("duo"), { price: 320, list: 475, from: null });
  assert.deepEqual(tierPrice("team"), { price: 163, list: 241, from: 489 });
  assert.deepEqual(tierPrice("pro"), { price: 334, list: 495, from: 1002 });
  assert.equal(tierPrice("trial").price, 0);
});

test("an extra phone number is sold at about what it costs Turf", () => {
  assert.equal(ADDONS.find(a => a.id === "numbers").price, 1);
});
