import assert from "node:assert/strict";
import { test } from "node:test";
import { nextStepOf } from "../src/next-step.ts";

const now = new Date(2026, 10, 15, 12, 0);
const lead = { id: "a", stage: "Contacted" };

test("the next step is the earliest open task, overdue once its time has passed", () => {
  const tasks = [
    { id: "2", leadId: "a", title: "Appointment", type: "Appointment", date: "2026-11-20", time: "10:00" },
    { id: "1", leadId: "a", title: "Call back", type: "Call", date: "2026-11-15", time: "09:00" },
    { id: "0", leadId: "a", title: "Done already", date: "2026-11-01", done: true },
    { id: "9", leadId: "b", title: "Another lead", date: "2026-11-02" },
  ];
  const step = nextStepOf(lead, tasks, now);
  assert.equal(step.kind, "task");
  assert.equal(step.id, "1");
  assert.equal(step.overdue, true);
});

test("without a task the callback is the next step; without either, the stage suggests one", () => {
  assert.deepEqual(nextStepOf({ ...lead, callbackDate: "2026-11-16", callback: "10:00" }, [], now), { kind: "callback", title: "Callback", type: "Call", date: "2026-11-16", time: "10:00", overdue: false });
  assert.equal(nextStepOf(lead, [], now).title, "Follow-up call");
  assert.equal(nextStepOf({ id: "a", stage: "Closed" }, [], now), null);
  assert.equal(nextStepOf({ id: "a", stage: "New", verdict: "Do not call" }, [], now), null);
});
