import assert from "node:assert/strict";
import test from "node:test";
import { readProfile, writeProfile } from "../src/profile-cache.ts";

const store = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
};

test("the last-known person is kept for the next page load, and forgotten on sign-out", () => {
  const storage = store();
  globalThis.localStorage = storage;
  assert.equal(readProfile(), null);
  writeProfile({ id: "u1", name: "Mohammed Hesham", email: "m@example.com", avatar: "data:image/png;base64,AAAA" });
  assert.deepEqual(readProfile(), { id: "u1", name: "Mohammed Hesham", email: "m@example.com", avatar: "data:image/png;base64,AAAA" });
  writeProfile(null);
  assert.equal(readProfile(), null);
});

test("nothing secret is kept, and a doctored value in storage is not trusted", () => {
  const storage = store();
  globalThis.localStorage = storage;
  writeProfile({ id: "u1", name: "A", email: "a@example.com", avatar: "", token: "secret", roles: ["owner"] });
  const kept = JSON.parse(storage.data.get("cw-profile"));
  assert.deepEqual(Object.keys(kept).sort(), ["avatar", "email", "id", "name"]);
  storage.data.set("cw-profile", JSON.stringify({ id: "u1", email: "a@example.com", name: "A", avatar: "javascript:alert(1)" }));
  assert.equal(readProfile().avatar, "", "only an inline PNG or JPEG is ever used as a picture");
  storage.data.set("cw-profile", "{not json");
  assert.equal(readProfile(), null);
  storage.data.set("cw-profile", JSON.stringify({ name: "no id" }));
  assert.equal(readProfile(), null);
});

test("a browser that refuses storage just remembers nothing", () => {
  globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(readProfile(), null);
  assert.doesNotThrow(() => writeProfile({ id: "u1", email: "a@example.com" }));
  assert.doesNotThrow(() => writeProfile(null));
});
