import test from "node:test";
import assert from "node:assert/strict";
import { problems } from "./check-timeouts.mjs";

test("a request with no time limit is found; a client with a Timeout is not", () => {
  assert.equal(problems(`c := &http.Client{Timeout: 5 * time.Second}`).length, 0);
  assert.equal(problems(`c := &http.Client{\n\tTimeout: 5 * time.Second,\n\tTransport: t,\n}`).length, 0);
  assert.deepEqual(problems(`x := http.DefaultClient`).map(p => p.line), [1]);
  assert.equal(problems(`resp, err := http.Get(url)`).length, 1);
  assert.equal(problems(`c := &http.Client{}`).length, 1);
  assert.equal(problems(`c := &http.Client{\n\tTransport: t,\n}`).length, 1);
  assert.equal(problems(`// http.DefaultClient is not used here`).length, 0);
});
