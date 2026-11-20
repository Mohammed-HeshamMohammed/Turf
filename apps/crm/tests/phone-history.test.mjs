import assert from "node:assert/strict";
import { test } from "node:test";
import { phoneHistory } from "../src/phone-history.ts";

test("each phone shows its calls, where it stands now, and do not call holds", () => {
  const lead = {
    phone: "(813) 555-0100",
    phoneType: "mobile",
    otherPhones: [{ number: "8135550199", type: "landline" }],
    calls: [
      { phone: "18135550100", outcome: "Voicemail", at: "2026-11-01T10:00" },
      { phone: "813-555-0100", outcome: "Callback", at: "2026-11-02T10:00", agent: "Bob" },
      { phone: "8135550199", outcome: "Do not call", meaning: "do_not_call", at: "2026-11-01T11:00" },
      { phone: "8135550199", outcome: "Voicemail", at: "2026-11-03T11:00" },
      { phone: "8135550777", outcome: "Wrong number", meaning: "wrong_number", at: "2026-11-04T09:00" },
    ],
  };
  const [main, other, old] = phoneHistory(lead);
  assert.equal(main.calls, 2);
  assert.equal(main.status, "Reached");
  assert.equal(main.last.agent, "Bob");
  assert.equal(other.status, "Do not call");
  assert.equal(old.status, "Wrong number");
  assert.equal(phoneHistory({ phone: "8135550100" })[0].status, "Not called yet");
});
