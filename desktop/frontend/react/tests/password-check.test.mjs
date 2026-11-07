import test from "node:test";
import assert from "node:assert/strict";
import { assess, EXAMPLE, MAX_LENGTH, MIN_LENGTH } from "../src/remote/password-check.ts";

test("nothing typed is neither accepted nor scored", () => {
  const empty = assess("");
  assert.deepEqual([empty.ok, empty.score, empty.label, empty.problem], [false, 0, "", ""]);
});

test("short passwords are refused and say how short", () => {
  const short = assess("abc123x");
  assert.equal(short.ok, false);
  assert.match(short.problem, new RegExp(`${MIN_LENGTH} characters`));
  assert.equal(assess("kq7vm2xd").ok, true, "exactly the minimum is allowed");
});

test("the example shown on screen is refused, however it is spelled", () => {
  for (const spelling of [EXAMPLE, EXAMPLE.toUpperCase(), "Maple River Tractor Candle!", "maple-river-tractor-candle", "mapleRIVERtractorcandle"]) {
    const result = assess(spelling);
    assert.equal(result.ok, false, spelling);
    assert.match(result.problem, /too common|our example/);
  }
  assert.equal(assess("maple river tractor wolf").ok, true, "a different phrase is fine");
});

test("common passwords, repeats and simple runs are refused", () => {
  for (const bad of [
    "password123",
    "Password1",
    "qwertyuiop",
    "12345678",
    "87654321",
    "aaaaaaaaaa",
    "abababababab",
    "abcdefghij",
    "CallerWhale123",
    "1q2w3e4r",
  ]) {
    assert.equal(assess(bad).ok, false, bad);
  }
  assert.equal(assess("blue-kettle-77-orbit").ok, true);
});

test("there is a longest length, counted in characters and not bytes", () => {
  assert.equal(assess("k7".repeat(MAX_LENGTH / 2 - 5) + "xqzvbnmlkj").ok, true);
  const long = assess("xq7v".repeat(MAX_LENGTH / 4) + "z");
  assert.equal(long.ok, false);
  assert.match(long.problem, new RegExp(String(MAX_LENGTH)));
  assert.equal(assess("日本語のパスワードです長い").ok, true, "other alphabets count by characters");
});

test("long beats complicated: a few random words outrank a short mix", () => {
  const short = assess("Tr0ub4d&3");
  const words = assess("copper window gentle harbor pencil");
  assert.ok(words.score > short.score, `${words.label} should beat ${short.label}`);
  assert.equal(words.label, "Strong");
  assert.equal(assess("kq7vm2xd").label, "Fair");
  assert.equal(assess("kq7vm2xdbn4w").label, "Good");
  assert.equal(assess("password123").label, "Weak", "a refused password is never shown as anything better than weak");
});

test("the checklist tells what is met and what is not", () => {
  const checks = assess("kq7vm2xd").checks;
  assert.deepEqual(
    checks.map((c) => c.pass),
    [true, false, true, true],
  );
});
