// The encrypted offline cache (plan 2.6, 2.7): records, cursor and the operation queue in IndexedDB (Dexie), every
// value sealed with AES-GCM under a key derived from the person's unlock passphrase (PBKDF2, 310 000 rounds).
// Without a passphrase nothing is written to disk; pending changes then live only in this tab.

import Dexie from "dexie";

type OfflineDb = Dexie & Record<"meta" | "sealed" | "queue", any>;
const makeDb = name => {
  const db = new Dexie(name) as OfflineDb;
  db.version(1).stores({ meta: "key", sealed: "key", queue: "id, seq" });
  return db;
};
const legacyDb = makeDb("callerwhale-crm-offline");
const dbFor = userId => makeDb("callerwhale-crm-offline-user-" + encodeURIComponent(userId));

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = bytes => {
  const data = new Uint8Array(bytes);
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += 8192) parts.push(String.fromCharCode(...data.subarray(i, i + 8192)));
  return btoa(parts.join(""));
};
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function deriveKey(passphrase, salt, extractable = false) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
}

// The tab keeps an unlocked copy of the AES key, never the device password. It ends with the tab or auth session.
const sessionKey = "cw-device-unlock";
function sessionUnlock() {
  try { return JSON.parse(sessionStorage.getItem(sessionKey) || "null"); } catch { return null; }
}
function rememberSession(owner, sessionId, raw) {
  try { sessionStorage.setItem(sessionKey, JSON.stringify({ owner, sessionId, key: toBase64(raw) })); } catch { /* Ask for the password after reload. */ }
}

async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value)));
  return { iv: toBase64(iv), data: toBase64(data) };
}

async function open(key, box) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(box.iv) }, key, fromBase64(box.data));
  return JSON.parse(decoder.decode(plain));
}

export class Vault {
  key: any; owner: any; db: OfflineDb; legacyOrg: string;
  constructor(key, owner, db, legacyOrg = "") {
    this.key = key;
    this.owner = owner;
    this.db = db;
    this.legacyOrg = legacyOrg;
  }

  /**
   * One encrypted copy per user on this device. The older shared copy is moved only after its password succeeds.
   */
  static async unlock(passphrase, owner, sessionId = "") {
    const db = dbFor(owner);
    let salt = (await db.meta.get("salt"))?.value;
    let legacyOrg = (await db.meta.get("legacy_org"))?.value || "";
    let migrated = false;
    if (!salt) {
      const holder = (await legacyDb.meta.get("owner"))?.value || "";
      const oldSalt = (await legacyDb.meta.get("salt"))?.value;
      const oldCheck = (await legacyDb.meta.get("check"))?.value;
      if ((holder === owner || holder.startsWith(owner + ":")) && oldSalt && oldCheck) {
        const oldKey = await deriveKey(passphrase, fromBase64(oldSalt));
        try {
          await open(oldKey, oldCheck);
        } catch {
          throw new Error("That password does not unlock this device's offline copy");
        }
        legacyOrg = holder.startsWith(owner + ":") ? holder.slice(owner.length + 1) : "";
        const [meta, sealed, queue] = await Promise.all([legacyDb.meta.toArray(), legacyDb.sealed.toArray(), legacyDb.queue.toArray()]);
        await db.transaction("rw", db.meta, db.sealed, db.queue, async () => {
          await db.meta.bulkPut(meta);
          await db.meta.bulkPut([{ key: "owner", value: owner }, { key: "legacy_org", value: legacyOrg }]);
          await db.sealed.bulkPut(sealed);
          await db.queue.bulkPut(queue);
        });
        salt = oldSalt;
        migrated = true;
      }
    }
    if (!salt) {
      salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
      await db.meta.bulkPut([{ key: "salt", value: salt }, { key: "owner", value: owner }]);
    }
    const derived = await deriveKey(passphrase, fromBase64(salt), Boolean(sessionId));
    const check = await db.meta.get("check");
    if (check) {
      try {
        await open(derived, check.value);
      } catch {
        throw new Error("That password does not unlock this device's offline copy");
      }
    } else {
      await db.meta.put({ key: "check", value: await seal(derived, "callerwhale") });
    }
    if (migrated) await Promise.all([legacyDb.meta.clear(), legacyDb.sealed.clear(), legacyDb.queue.clear()]);
    if (!sessionId) return new Vault(derived, owner, db, legacyOrg);
    const raw = await crypto.subtle.exportKey("raw", derived);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    rememberSession(owner, sessionId, raw);
    return new Vault(key, owner, db, legacyOrg);
  }

  /** Reopen this user's encrypted copy only for the same signed-in tab session. */
  static async resume(owner, sessionId) {
    const saved = sessionUnlock();
    if (!sessionId || saved?.owner !== owner || saved?.sessionId !== sessionId || typeof saved.key !== "string") return null;
    try {
      const db = dbFor(owner);
      const check = (await db.meta.get("check"))?.value;
      if (!check) throw new Error("No offline copy");
      const key = await crypto.subtle.importKey("raw", fromBase64(saved.key), "AES-GCM", false, ["encrypt", "decrypt"]);
      await open(key, check);
      return new Vault(key, owner, db, (await db.meta.get("legacy_org"))?.value || "");
    } catch {
      Vault.clearSession();
      return null;
    }
  }

  static clearSession() {
    try { sessionStorage.removeItem(sessionKey); } catch { /* No browser session storage. */ }
  }

  /** Whether this device already holds an offline copy for this account (made earlier with a password). */
  static async has(owner) {
    try {
      const db = dbFor(owner);
      if ((await db.meta.get("check"))?.value) return true;
      const holder = (await legacyDb.meta.get("owner"))?.value || "";
      return (holder === owner || holder.startsWith(owner + ":")) && !!(await legacyDb.meta.get("check"));
    } catch {
      return false;
    }
  }

  static async wipe(owner) {
    if (!owner) throw new Error("Choose the offline copy to remove");
    if (sessionUnlock()?.owner === owner) Vault.clearSession();
    const db = dbFor(owner);
    await Promise.all([db.meta.clear(), db.sealed.clear(), db.queue.clear()]);
    const holder = (await legacyDb.meta.get("owner"))?.value || "";
    if (holder === owner || holder.startsWith(owner + ":")) {
      await Promise.all([legacyDb.meta.clear(), legacyDb.sealed.clear(), legacyDb.queue.clear()]);
    }
  }

  async get(name) {
    const row = await this.db.sealed.get(name);
    if (!row) return null;
    const value = await open(this.key, row.value);
    return name === "store" && value && !value.organizationId && this.legacyOrg
      ? { ...value, organizationId: this.legacyOrg } : value;
  }

  async put(name, value) {
    try {
      await this.db.sealed.put({ key: name, value: await seal(this.key, value) });
      return true;
    } catch (error) {
      // Quota exhausted: pending edits matter more than cached records, so the caller is told (plan 2.6).
      if (error?.name === "QuotaExceededError" || error?.inner?.name === "QuotaExceededError") return false;
      throw error;
    }
  }

  async queue() {
    const rows = await this.db.queue.orderBy("seq").toArray();
    return Promise.all(rows.map(async row => ({ ...(await open(this.key, row.value)), seq: row.seq })));
  }

  async enqueue(op) {
    const seq = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    await this.db.queue.put({ id: op.id, seq, value: await seal(this.key, op) });
  }

  async update(op) {
    const row = await this.db.queue.get(op.id);
    if (row) await this.db.queue.put({ ...row, value: await seal(this.key, op) });
  }

  async remove(id) {
    await this.db.queue.delete(id);
  }

  /** Drops synchronized records but keeps pending operations (access changed, or the lease expired). */
  async dropRecords() {
    await this.db.sealed.clear();
  }
}

/** A vault-shaped store that keeps everything in memory, for people who choose no passphrase. */
export class MemoryVault {
  values: Map<string, any>; ops: any[];
  constructor() {
    this.values = new Map();
    this.ops = [];
  }
  async get(name) {
    return this.values.get(name) ?? null;
  }
  async put(name, value) {
    this.values.set(name, structuredClone(value));
    return true;
  }
  async queue() {
    return [...this.ops];
  }
  async enqueue(op) {
    this.ops.push({ ...op, seq: this.ops.length });
  }
  async update(op) {
    this.ops = this.ops.map(item => (item.id === op.id ? { ...op, seq: item.seq } : item));
  }
  async remove(id) {
    this.ops = this.ops.filter(item => item.id !== id);
  }
  async dropRecords() {
    this.values.clear();
  }
}
