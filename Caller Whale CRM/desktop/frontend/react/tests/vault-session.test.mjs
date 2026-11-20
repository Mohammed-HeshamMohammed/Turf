import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";

test("an encrypted device copy resumes only in its signed-in tab session", async () => {
  const { Vault } = await import("../src/remote/vault.ts");
  const saved = new Map();
  globalThis.sessionStorage = {
    getItem: key => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  };
  const user = crypto.randomUUID();
  try {
    const first = await Vault.unlock("a long device password for this test", user, "auth-session-one");
    await first.put("store", { organizationId: "workspace-one", leads: { one: { id: "one" } } });
    const large = { organizationId: "workspace-one", notes: Array.from({ length: 20_000 }, (_, n) => ({ id: n, text: "Call note and imported row " + n })) };
    await first.put("store", large);
    assert.equal((await first.get("store")).notes.length, 20_000);
    await first.put("store", { organizationId: "workspace-one", leads: { one: { id: "one" } } });
    await first.enqueue({ id: "pending-one", status: "Pending" });

    const resumed = await Vault.resume(user, "auth-session-one");
    assert.equal((await resumed.get("store")).leads.one.id, "one");
    assert.equal((await resumed.queue())[0].id, "pending-one");
    assert.equal(await Vault.resume(user, "another-auth-session"), null);
    assert.equal(await Vault.resume(crypto.randomUUID(), "auth-session-one"), null);
    assert.equal([...saved.values()].some(value => value.includes("a long device password")), false);

    Vault.clearSession();
    assert.equal(await Vault.resume(user, "auth-session-one"), null);
    assert.equal(await Vault.has(user), true);
    await Vault.wipe(user);
  } finally {
    delete globalThis.sessionStorage;
  }
});
