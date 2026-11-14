// Team chats from the messaging service, shaped for the Inbox: who said what, replies, reactions, polls, and what the person sends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Messaging, mentionedIds, toThread } from "../src/remote/messaging.ts";

const ME = "11111111-1111-4111-8111-111111111111";
const MAYA = "22222222-2222-4222-8222-222222222222";
const ALEX = "33333333-3333-4333-8333-333333333333";
const people = [{ id: ME, name: "Lena Ortiz" }, { id: MAYA, name: "Maya Chen" }, { id: ALEX, name: "Alex Rivera" }];
const NOW = new Date("2026-11-14T15:00:00");

const message = (seq, sender, body, more = {}) => ({
  id: "m" + seq, conversation_id: "c1", seq, sender_id: sender, kind: "text", body, reply_to: null, mentions: [],
  created_at: "2026-11-14T10:0" + seq + ":00", edited_at: null, deleted: false, reactions: [], poll: null, ...more,
});
const conversation = (more = {}) => ({
  id: "c1", kind: "direct", title: "", last_seq: 0, last_read_seq: 0, unread: 0, archived: false, muted: false,
  members: [{ user_id: ME, role: "member" }, { user_id: MAYA, role: "member" }], last_message: null, last_message_at: null, ...more,
});

test("a direct chat is titled with the other person and says who wrote each message", () => {
  const thread = toThread(conversation({ unread: 1 }), [message(1, ME, "Offer sent"), message(2, MAYA, "Great", { reply_to: "m1" })], people, ME, NOW);
  assert.equal(thread.title, "Maya Chen");
  assert.equal(thread.channel, "Team");
  assert.equal(thread.chat, true);
  assert.equal(thread.unread, true);
  assert.equal(thread.preview, "Great");
  assert.deepEqual(thread.messages.map(item => [item.from, item.incoming, item.text]), [["Lena Ortiz", false, "Offer sent"], ["Maya Chen", true, "Great"]]);
  assert.equal(thread.messages[1].replyTo, 0, "a reply points at the message it answers");
  assert.equal(thread.messages[0].at, "10:01");
});

test("a group keeps its name and members; reactions and votes are shown by name", () => {
  const group = conversation({ kind: "group", title: "Closers", members: [{ user_id: ME, role: "owner" }, { user_id: MAYA, role: "member" }, { user_id: ALEX, role: "member" }] });
  const poll = message(2, MAYA, "When?", { kind: "poll", poll: { question: "When?", options: ["Morning", "Afternoon"], votes: [{ user_id: ME, option: 1 }, { user_id: ALEX, option: 1 }] } });
  const reacted = message(1, ALEX, "Signed", { reactions: [{ emoji: "🎉", user_id: ME }, { emoji: "🎉", user_id: MAYA }] });
  const thread = toThread(group, [reacted, poll, message(3, ME, "added", { kind: "system", mentions: [ALEX] }), message(4, ALEX, "", { deleted: true })], people, ME, NOW);
  assert.equal(thread.channel, "Group");
  assert.equal(thread.title, "Closers");
  assert.deepEqual(thread.members, ["Lena Ortiz", "Maya Chen", "Alex Rivera"]);
  assert.deepEqual(thread.messages[0].reactions, { "🎉": ["Lena Ortiz", "Maya Chen"] });
  assert.deepEqual(thread.messages[1].poll.options, [{ text: "Morning", votes: [] }, { text: "Afternoon", votes: ["Lena Ortiz", "Alex Rivera"] }]);
  assert.equal(thread.messages[2].text, "Lena Ortiz added Alex Rivera");
  assert.equal(thread.messages[3].text, "Message deleted");
});

test("someone who has left the workspace still has their messages, without a name", () => {
  const thread = toThread(conversation(), [message(1, "99999999-9999-4999-8999-999999999999", "old")], people, ME, NOW);
  assert.equal(thread.messages[0].from, "Former member");
});

test("@names in a message become the people mentioned", () => {
  assert.deepEqual(mentionedIds("Thanks @Maya Chen, see @Alex Rivera", people), [MAYA, ALEX]);
  assert.deepEqual(mentionedIds("no one here", people), []);
});

/** A stand-in for the service: one direct chat, holding whatever is sent to it. */
function service({ refuseSend = false } = {}) {
  const held = [message(1, MAYA, "Hello")];
  const calls = [];
  const ask = async (method, path, body) => {
    calls.push(method + " " + path.replace("/api/v1/messaging", ""));
    if (path.endsWith("/conversations") && method === "GET") return { conversations: [conversation({ last_seq: held.at(-1).seq, unread: 1, last_message: held.at(-1) })] };
    if (path.includes("/messages") && method === "GET") {
      const after = Number(new URL("http://x" + path).searchParams.get("after") || 0);
      return { messages: held.filter(item => item.seq > after) };
    }
    if (path.endsWith("/messages") && method === "POST") {
      if (refuseSend) throw new Error("The server cannot be reached");
      const saved = message(held.length + 1, ME, body.body, { id: body.id, reply_to: body.reply_to || null, mentions: body.mentions || [] });
      held.push(saved);
      return { message: saved };
    }
    if (path.includes("/reactions/")) {
      const target = held.find(item => path.includes(item.id));
      target.reactions = method === "PUT" ? [...target.reactions, { emoji: "👍", user_id: ME }] : target.reactions.filter(item => item.user_id !== ME);
      return { message: target };
    }
    return {};
  };
  return { ask, calls, held };
}

const client = (fake, seen, errors = []) => new Messaging({ base: "http://messaging", me: ME, people, ask: fake.ask, live: false, interval: 3_600_000, onThreads: threads => seen.push(threads), onError: error => errors.push(error) });

test("a sent message shows at once, is saved once, and then is the server's own", async () => {
  const fake = service();
  const seen = [];
  const chat = client(fake, seen);
  await chat.start();
  assert.equal(seen.at(-1)[0].messages.length, 1);

  const sending = chat.send("c1", "  On my way @Maya Chen ", { replyTo: 0 });
  const optimistic = seen.at(-1)[0];
  assert.deepEqual([optimistic.messages.length, optimistic.messages[1].text, optimistic.messages[1].at, optimistic.preview], [2, "On my way @Maya Chen", "Sending…", "On my way @Maya Chen"]);
  await sending;
  chat.stop();

  const settled = seen.at(-1)[0];
  assert.equal(settled.messages.length, 2, "the message is there once, not twice");
  assert.equal(settled.messages[1].replyTo, 0);
  assert.equal(fake.held[1].reply_to, "m1");
  assert.deepEqual(fake.held[1].mentions, [MAYA]);
  // Catching up asks only for what came after the last message held.
  assert.ok(fake.calls.includes("GET /conversations/c1/messages?after=1"), fake.calls.join("\n"));
});

test("a message the server refuses stays on screen marked not sent, and the person is told", async () => {
  const fake = service({ refuseSend: true });
  const seen = [];
  const errors = [];
  const chat = client(fake, seen, errors);
  await chat.start();
  await chat.send("c1", "Are you there?");
  chat.stop();
  const last = seen.at(-1)[0].messages.at(-1);
  assert.deepEqual([last.text, last.draft, last.at], ["Are you there?", true, "Not sent"]);
  assert.deepEqual(errors, ["The server cannot be reached"]);
});

test("a reaction is given, and taken back when given again", async () => {
  const fake = service();
  const seen = [];
  const chat = client(fake, seen);
  await chat.start();
  await chat.react("c1", 0, "👍");
  assert.deepEqual(seen.at(-1)[0].messages[0].reactions, { "👍": ["Lena Ortiz"] });
  await chat.react("c1", 0, "👍");
  chat.stop();
  assert.equal(seen.at(-1)[0].messages[0].reactions, undefined);
  assert.ok(fake.calls.some(call => call.startsWith("DELETE /messages/m1/reactions/")));
});

test("marking unread is this device's reminder until the conversation is opened again", async () => {
  const fake = service();
  const seen = [];
  const chat = client(fake, seen);
  await chat.start();
  fake.ask = null;
  chat.markUnread("c1");
  assert.equal(seen.at(-1)[0].unread, true);
  assert.equal(chat.has("c1"), true);
  assert.equal(chat.has("other"), false);
  chat.stop();
});
