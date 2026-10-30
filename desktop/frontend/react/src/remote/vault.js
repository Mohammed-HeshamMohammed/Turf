// The encrypted offline cache (plan 2.6, 2.7): records, cursor and the operation queue in IndexedDB (Dexie), every
// value sealed with AES-GCM under a key derived from the person's unlock passphrase (PBKDF2, 310 000 rounds).
// Without a passphrase nothing is written to disk; pending changes then live only in this tab.

import Dexie from "dexie";

const db = new Dexie("callerwhale-crm-offline");
db.version(1).stores({ meta: "key", sealed: "key", queue: "id, seq" });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
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
  constructor(key, owner) {
    this.key = key;
    this.owner = owner;
  }

  /**
   * Unlocks (or creates) the vault for one account. A wrong passphrase fails; a vault that belongs to another
   * account is emptied first, so one person's offline records never show to the next.
   */
  static async unlock(passphrase, owner) {
    let salt = (await db.meta.get("salt"))?.value;
    const holder = (await db.meta.get("owner"))?.value;
    if (holder && holder !== owner) await Vault.wipe();
    if (!salt || holder !== owner) {
      salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
      await db.meta.bulkPut([{ key: "salt", value: salt }, { key: "owner", value: owner }]);
    }
    const key = await deriveKey(passphrase, fromBase64(salt));
    const check = await db.meta.get("check");
    if (check) {
      try {
        await open(key, check.value);
      } catch {
        throw new Error("That passphrase does not unlock this device's offline copy");
      }
    } else {
      await db.meta.put({ key: "check", value: await seal(key, "callerwhale") });
    }
    return new Vault(key, owner);
  }

  static async wipe() {
    await Promise.all([db.meta.clear(), db.sealed.clear(), db.queue.clear()]);
  }

  async get(name) {
    const row = await db.sealed.get(name);
    return row ? open(this.key, row.value) : null;
  }

  async put(name, value) {
    try {
      await db.sealed.put({ key: name, value: await seal(this.key, value) });
      return true;
    } catch (error) {
      // Quota exhausted: pending edits matter more than cached records, so the caller is told (plan 2.6).
      if (error?.name === "QuotaExceededError" || error?.inner?.name === "QuotaExceededError") return false;
      throw error;
    }
  }

  async queue() {
    const rows = await db.queue.orderBy("seq").toArray();
    return Promise.all(rows.map(async row => ({ ...(await open(this.key, row.value)), seq: row.seq })));
  }

  async enqueue(op) {
    const seq = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    await db.queue.put({ id: op.id, seq, value: await seal(this.key, op) });
  }

  async update(op) {
    const row = await db.queue.get(op.id);
    if (row) await db.queue.put({ ...row, value: await seal(this.key, op) });
  }

  async remove(id) {
    await db.queue.delete(id);
  }

  /** Drops synchronized records but keeps pending operations (access changed, or the lease expired). */
  async dropRecords() {
    await db.sealed.clear();
  }
}

/** A vault-shaped store that keeps everything in memory, for people who choose no passphrase. */
export class MemoryVault {
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
