// node --test tools/env-init.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { signingKey } from "./env-init.mjs";

test("a generated signing key is PKCS#8 v2 with its own public key, and signs", () => {
  const der = Buffer.from(signingKey(), "base64");
  assert.equal(der.length, 85, "v2: the seed and the public key");
  assert.equal(der[4], 1, "version 2 (encoded as 1)");
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(key);
  assert.deepEqual(der.subarray(-32), Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"), "the public key inside is the key's own");
  assert.ok(verify(null, Buffer.from("callerwhale"), publicKey, sign(null, Buffer.from("callerwhale"), key)));
  assert.notEqual(signingKey(), signingKey());
});
