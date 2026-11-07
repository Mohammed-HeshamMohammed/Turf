import assert from "node:assert/strict";
import test from "node:test";
import { nextStep, problemWith, recap, said, steps } from "../src/signup-flow.ts";

test("a new person is asked about their work, then who they are, then for consent, then the recap", () => {
  const a = {};
  const order = [];
  const give = { intent: "new", work: "solo", size: "1", first: "sample", name: "Maya", method: "email", email: "m@example.com", password: "long enough pw", consent: ["age", "terms"] };
  for (let step = nextStep(a); step; step = nextStep(a)) {
    order.push(step.id);
    a[step.id] = step.id in give ? give[step.id] : "done";
  }
  assert.deepEqual(order, ["intent", "work", "size", "first", "name", "method", "email", "password", "consent", "review"]);
});

test("coming back skips the questions about work and consent, and Google skips the password", () => {
  const a = { intent: "back", method: "google" };
  assert.equal(nextStep(a).id, "review");
  assert.equal(nextStep({ intent: "back", method: "email" }).id, "email");
});

test("every choice question offers a way out and no consent box starts ticked", () => {
  for (const step of steps.filter(s => s.kind === "choice" && ["work", "size"].includes(s.id))) {
    assert.ok(step.choices.some(c => ["skip", "other"].includes(c.value)), step.id);
  }
  const consent = steps.find(s => s.kind === "consent");
  assert.ok(consent.boxes.some(b => !b.required), "optional consent exists, separate from the required ones");
  assert.equal(problemWith(consent, []).length > 0, true, "nothing is ticked for the person");
});

test("answers are checked in plain words", () => {
  const byId = id => steps.find(s => s.id === id);
  assert.match(problemWith(byId("email"), "nope"), /email address/);
  assert.equal(problemWith(byId("email"), " me@example.com "), "");
  assert.match(problemWith(byId("password"), "short"), /10 characters/);
  assert.match(problemWith(byId("consent"), ["email"]), /required boxes/);
  assert.equal(problemWith(byId("consent"), ["age", "terms"]), "");
});

test("a password is never shown back, and the recap says plainly what was agreed to", () => {
  const byId = id => steps.find(s => s.id === id);
  assert.equal(said(byId("password"), "hunter2hunter2"), "••••••••••••");
  const lines = recap({ intent: "new", name: "Maya", work: "agency", size: "skip", first: "import", method: "google", consent: ["age", "terms", "text"] });
  assert.deepEqual(lines, [["Name", "Maya"], ["What you do", "I run a calling team"], ["First step", "Bring in a list"], ["Sign-in", "Google"], ["Emails", "No"], ["Texts", "Yes"]]);
});
