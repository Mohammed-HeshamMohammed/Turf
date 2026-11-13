// The shared source of paged leads: one ask for one page, whoever wants it, and an answer kept until the records change.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeadSource } from "../src/lead-source.ts";

const answers = (calls, total = 120) => ask => {
  calls.push(ask);
  return Promise.resolve({ ids: Array.from({ length: ask.limit }, (_, n) => `lead-${ask.offset + n}`), total: ask.count ? total : null });
};

test("a page asked for twice at once is fetched once", async () => {
  const source = createLeadSource();
  const calls = [];
  const [a, b] = await Promise.all([source.load({ offset: 0, limit: 10 }, answers(calls)), source.load({ offset: 0, limit: 10 }, answers(calls))]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});

test("a page held from before answers without asking again", async () => {
  const source = createLeadSource();
  const calls = [];
  await source.load({ offset: 0, limit: 10 }, answers(calls));
  const again = await source.load({ offset: 0, limit: 10 }, answers(calls));
  assert.equal(calls.length, 1);
  assert.equal(again.ids[0], "lead-0");
  assert.equal(source.peek({ offset: 0, limit: 10 }).stale, false);
});

test("the total is counted once per search, not once per page", async () => {
  const source = createLeadSource();
  const calls = [];
  const first = await source.load({ stage: "New", offset: 0, limit: 10 }, answers(calls));
  const second = await source.load({ stage: "New", offset: 10, limit: 10 }, answers(calls));
  assert.equal(calls[0].count, true);
  assert.equal(calls[1].count, false);
  assert.equal(first.total, 120);
  assert.equal(second.total, 120);
  assert.equal(source.knownTotal({ stage: "New" }), 120);
});

test("different searches, stages and lists do not share answers", async () => {
  const source = createLeadSource();
  const calls = [];
  await source.load({ stage: "New", offset: 0, limit: 10 }, answers(calls));
  await source.load({ stage: "Closed", offset: 0, limit: 10 }, answers(calls));
  await source.load({ project: "p1", callable: true, offset: 0, limit: 10 }, answers(calls));
  assert.equal(calls.length, 3);
});

test("after the records change a held page is still shown, marked stale, and asked for again", async () => {
  const source = createLeadSource();
  const calls = [];
  let heard = 0;
  source.subscribe(() => heard++);
  await source.load({ offset: 0, limit: 10 }, answers(calls));
  source.invalidate();
  assert.equal(heard, 1);
  const shown = source.peek({ offset: 0, limit: 10 });
  assert.equal(shown.stale, true);
  assert.equal(shown.page.ids.length, 10);
  await source.load({ offset: 0, limit: 10 }, answers(calls));
  assert.equal(calls.length, 2);
  assert.equal(source.peek({ offset: 0, limit: 10 }).stale, false);
});

test("an answer that arrives after the records changed is not trusted as fresh", async () => {
  const source = createLeadSource();
  const calls = [];
  const pending = source.load({ offset: 0, limit: 10 }, answers(calls));
  source.invalidate();
  await pending;
  assert.equal(source.peek({ offset: 0, limit: 10 }).stale, true);
});

test("switching workspace forgets everything", async () => {
  const source = createLeadSource();
  await source.load({ offset: 0, limit: 10 }, answers([]));
  source.clear();
  assert.equal(source.peek({ offset: 0, limit: 10 }), null);
  assert.equal(source.size(), 0);
});

test("a failed ask is not kept, so the next one tries again", async () => {
  const source = createLeadSource();
  await assert.rejects(source.load({ offset: 0, limit: 10 }, () => Promise.reject(new Error("offline"))));
  const calls = [];
  await source.load({ offset: 0, limit: 10 }, answers(calls));
  assert.equal(calls.length, 1);
});

test("only a bounded number of pages is kept", async () => {
  const source = createLeadSource();
  for (let offset = 0; offset < 350; offset++) await source.load({ offset, limit: 1 }, answers([]));
  assert.ok(source.size() <= 300);
});
