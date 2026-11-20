import assert from "node:assert/strict";
import test from "node:test";
import { ask, FIRST_QUESTION, greeting, MAX_CHARS, MAX_TURNS, nudgeFor, outgoing, turnFrom } from "../src/assistant-client.ts";

test("only real turns are sent: not the greeting, not blanks, the last twelve, each cut to the limit", () => {
  const turns = [greeting, ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i === 19 ? "x".repeat(MAX_CHARS + 50) : "turn " + i })), { role: "user", content: "   " }];
  const sent = outgoing(turns);
  assert.equal(sent.length, MAX_TURNS);
  assert.equal(sent.at(-1).content.length, MAX_CHARS);
  assert.ok(!sent.some(turn => turn.content === greeting.content));
  assert.deepEqual(Object.keys(sent[0]).sort(), ["content", "role"], "nothing but role and text leaves the browser");
});

test("a reply can link only to a page on this site, and suggestions are plain text", () => {
  const bad = turnFrom({ source: "ai", answer: { reply: "hi", link: { label: "Win a prize", to: "https://evil.example" }, suggestions: ["ok", 7, "also"] } });
  assert.equal(bad.link, undefined);
  assert.deepEqual(bad.suggestions, ["ok", "also"]);
  assert.equal(turnFrom({ source: "ai", answer: { reply: "hi", link: { label: "x", to: "//evil.example" } } }).link, undefined);
  assert.deepEqual(turnFrom({ source: "scripted", answer: { reply: "hi", link: { label: "See pricing", to: "/pricing" } } }).link, { label: "See pricing", to: "/pricing" });
});

test("a suggestion opens by itself only where people choose a plan, and only after they have stayed a while", () => {
  assert.equal(nudgeFor("/pricing", 5), null);
  assert.equal(nudgeFor("/pricing", 12).ask, FIRST_QUESTION);
  assert.equal(nudgeFor("/", 10), null);
  assert.ok(nudgeFor("/", 25));
  for (const page of ["/signin", "/signup", "/forgot", "/account", "/dashboard", "/privacy"]) assert.equal(nudgeFor(page, 999), null, page + " is never interrupted");
});

test("the question goes to the assistant service as JSON and a busy or broken service is told in plain words", async () => {
  const calls = [];
  const fetcher = status => async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    return { status, ok: status === 200, json: async () => ({ source: "scripted", answer: { reply: "Yes, 7 days." } }) };
  };
  const turn = await ask([{ role: "user", content: "free trial?" }], "/pricing", undefined, "https://assistant.example", fetcher(200));
  assert.equal(turn.content, "Yes, 7 days.");
  assert.deepEqual(calls[0], ["https://assistant.example/v1/chat", { messages: [{ role: "user", content: "free trial?" }], page: "/pricing" }]);
  await assert.rejects(ask([{ role: "user", content: "x" }], "/", undefined, "https://a.example", fetcher(429)), /a lot of messages/);
  await assert.rejects(ask([{ role: "user", content: "x" }], "/", undefined, "https://a.example", fetcher(500)), /not available/);
});
