import assert from "node:assert/strict";
import test from "node:test";
import { dialerClient, toDialerOutcome } from "../src/remote/dialer.ts";

function recorder(answer = { id: "call-1" }) {
  const sent = [];
  const send = async (method, path, body, options) => {
    sent.push({ method, path, body, base: options?.base });
    return answer;
  };
  return { sent, client: dialerClient(send, () => "https://dialer.example") };
}

test("outcomes the dialer does not take are left to the carrier", () => {
  assert.equal(toDialerOutcome("Callback"), "Callback");
  assert.equal(toDialerOutcome("Do not call"), "Do not call");
  assert.equal(toDialerOutcome("Transfer"), "Transfer");
  assert.equal(toDialerOutcome("Voicemail"), "auto");
  assert.equal(toDialerOutcome("Not available"), "auto");
});

test("placing a call sends only the lead, never a phone number", async () => {
  const { sent, client } = recorder();
  await client.place("lead-1");
  assert.deepEqual(sent[0], { method: "POST", path: "/api/v1/calls", body: { lead_id: "lead-1" }, base: "https://dialer.example" });
});

test("following and hanging up use the dialer's call id", async () => {
  const { sent, client } = recorder();
  await client.get("call-1");
  await client.hangup("call-1");
  assert.deepEqual(sent.map(item => item.method + " " + item.path), ["GET /api/v1/calls/call-1", "POST /api/v1/calls/call-1/hangup"]);
});

test("a callback carries its time as RFC 3339, and do-not-call goes on the agency's list", async () => {
  const { sent, client } = recorder();
  await client.wrapUp("call-1", { outcome: "Callback", callbackAt: "2026-11-28T15:00", notes: "After work" });
  assert.equal(sent[0].path, "/api/v1/calls/call-1/disposition");
  assert.deepEqual(sent[0].body, { outcome: "Callback", callback_at: new Date("2026-11-28T15:00").toISOString(), notes: "After work", dnc_kind: "" });
  await client.wrapUp("call-1", { outcome: "Do not call" });
  assert.equal(sent[1].body.dnc_kind, "agency");
  assert.equal(sent[1].body.callback_at, "");
});
