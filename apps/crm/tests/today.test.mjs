import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setClock, setWorkspaceTimeZone, today } from "../src/data.ts";

afterEach(() => {
  setClock();
  setWorkspaceTimeZone();
});

test("today follows the clock, as YYYY-MM-DD", () => {
  setClock(() => new Date(2026, 10, 27, 12, 0));
  assert.equal(today(), "2026-11-27");
});

test("today is the workspace's day, not the device's", () => {
  // 22:30 UTC on 27 Nov is 00:30 on 28 Nov in Cairo but still 17:30 on 27 Nov in New York.
  setClock(() => new Date("2026-11-27T22:30:00Z"));
  setWorkspaceTimeZone("America/New_York");
  assert.equal(today(), "2026-11-27");
  setWorkspaceTimeZone("Africa/Cairo");
  assert.equal(today(), "2026-11-28");
});

test("an unknown time zone falls back to the device's day instead of breaking the app", () => {
  setClock(() => new Date(2026, 10, 27, 12, 0));
  setWorkspaceTimeZone("Not/AZone");
  assert.equal(today(), "2026-11-27");
});
