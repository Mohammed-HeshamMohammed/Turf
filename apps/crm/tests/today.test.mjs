import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { seedState, setClock, setWorkspaceTimeZone, today, wallTimeInstant } from "../src/data.ts";

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

test("today can be asked for another zone", () => {
  setClock(() => new Date("2026-11-27T22:30:00Z"));
  assert.equal(today("Africa/Cairo"), "2026-11-28");
});

test("a wall-clock time in the workspace's zone becomes the right instant, across daylight saving", () => {
  setWorkspaceTimeZone("America/New_York");
  assert.equal(wallTimeInstant("2026-11-28T10:00"), "2026-11-28T15:00:00.000Z");
  assert.equal(wallTimeInstant("2026-07-01T10:00"), "2026-07-01T14:00:00.000Z");
  assert.equal(wallTimeInstant("2026-11-28T10:00", "Africa/Cairo"), "2026-11-28T08:00:00.000Z");
  assert.equal(wallTimeInstant("tomorrow"), "");
});

test("the sample workspace is dated in its own zone, even before the app has set one", () => {
  // 00:30 on 28 Nov in Cairo is still 27 Nov in New York, the sample workspace's zone.
  setClock(() => new Date("2026-11-27T22:30:00Z"));
  const state = seedState();
  assert.equal(state.settings.timezone, "America/New_York");
  assert.ok(state.tasks.filter(task => task.type === "Callback").every(task => task.date === "2026-11-27"));
  assert.ok(state.leads.filter(lead => lead.callback).every(lead => lead.callbackDate === "2026-11-27"));
});
