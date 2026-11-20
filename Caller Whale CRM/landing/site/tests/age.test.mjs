import assert from "node:assert/strict";
import test from "node:test";
import { ageOn, ageProblem, latestBirthDate } from "../src/age.ts";

const today = new Date(2026, 10, 5); // 5 November 2026

test("age counts whole years and turns over on the birthday", () => {
  assert.equal(ageOn("2008-11-05", today), 18);
  assert.equal(ageOn("2008-11-06", today), 17);
  assert.equal(ageOn("1990-02-30", today), null);
  assert.equal(ageOn("not a date", today), null);
});

test("under 18, a future date or an impossible age is explained; an adult is fine", () => {
  assert.match(ageProblem("2010-01-01", today), /18 or older/);
  assert.match(ageProblem("2027-01-01", today), /real date/);
  assert.match(ageProblem("1890-01-01", today), /real date/);
  assert.equal(ageProblem("1990-06-15", today), "");
  assert.equal(ageProblem("", today), "");
});

test("the latest allowed birth date is exactly 18 years ago", () => {
  assert.equal(latestBirthDate(today), "2008-11-05");
});
