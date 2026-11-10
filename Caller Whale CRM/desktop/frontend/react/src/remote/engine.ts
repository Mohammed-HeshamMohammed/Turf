// The client side of synchronization (plan 2.7).
//
// Sequence on every sync: confirm the session and permissions, push queued operations in the order they were made,
// then pull committed changes until caught up. A moved access revision or an expired offline lease drops the cached
// records (never the queue) and takes a fresh snapshot. One tab syncs at a time (Web Locks); the others hear about it
// on a BroadcastChannel. Client clocks never decide anything: the server answers each operation.

import { api as defaultApi, ApiError, auth, eventsUrl, socketProtocols } from "./api.ts";
import { applyChanges, storeFromSnapshot } from "./translate.ts";

export class SyncEngine {
  vault: any; api: any; onChange: any; useSocket: any; store: any; ops: any[]; online: boolean; reachable: boolean; status: string;
  error: string; running: any; again: boolean; channel: any; socket: any; stopped: any; connecting: any; extra: any; retryTimer: any;
  constructor({ vault, api = defaultApi, onChange = () => {}, socket = true }: any) {
    this.vault = vault;
    this.api = api;
    this.onChange = onChange;
    this.useSocket = socket;
    this.store = null;
    this.ops = [];
    this.online = true;
    this.reachable = true;
    this.status = "idle";
    this.error = "";
    this.running = null;
    this.again = false;
    this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("callerwhale-sync") : null;
    if (this.channel) this.channel.onmessage = () => this.reload();
  }

  emit() {
    this.onChange({ store: this.store, ops: this.ops, status: this.status, error: this.error, online: this.online && this.reachable });
  }

  async reload() {
    this.store = (await this.vault.get("store")) || this.store;
    this.ops = await this.vault.queue();
    this.emit();
  }

  /** Loads the offline copy, refreshes the shared lists, and starts syncing. */
  async start(extra) {
    this.extra = extra;
    this.store = await this.vault.get("store");
    this.ops = await this.vault.queue();
    if (this.store && this.store.organizationId !== extra.organizationId) {
      if (this.ops.length) throw new Error("This device has pending changes for its previous workspace. Open that workspace and sync them before switching.");
      // Keep the previous offline copy until the new workspace's snapshot has arrived.
      await this.snapshot();
    }
    const expired = this.store?.leaseExpiresAt && new Date(this.store.leaseExpiresAt) < new Date();
    if (expired) {
      // Offline access must be renewed online within a day (plan 2.7).
      await this.vault.dropRecords();
      this.store = null;
    }
    if (this.store) this.store = { ...this.store, ...extra };
    this.emit();
    // The workspace opens at once: the first load of the records (which can be large) runs behind it, and the page shows it is loading.
    void this.sync();
    if (this.useSocket) this.connect();
    if (typeof window !== "undefined") {
      const again = () => {
        if (!this.reachable && !document.hidden) this.sync();
      };
      window.addEventListener("online", again);
      document.addEventListener("visibilitychange", again);
    }
  }

  setOnline(online) {
    this.online = online;
    this.emit();
    if (online) this.sync();
  }

  async enqueue(op) {
    const queued = { ...op, status: "Pending" };
    this.ops = [...this.ops, queued];
    await this.vault.enqueue(queued);
    this.emit();
    this.sync();
  }

  /** Discards a rejected or conflicting change, or (for a conflict) re-applies it over the server's values. */
  async resolve(id, choice) {
    const op = this.ops.find(item => item.id === id);
    if (!op) return;
    await this.vault.remove(id);
    this.ops = this.ops.filter(item => item.id !== id);
    if (choice === "keep" && op.status === "Conflict" && op.fields) {
      const base = Object.fromEntries(Object.entries<any>(op.fields).map(([field, values]) => [field, values.server]));
      await this.enqueue({ ...op, id: crypto.randomUUID(), payload: { ...op.payload, base: { ...op.payload.base, ...base } }, fields: undefined, message: undefined });
    }
    this.emit();
    this.channel?.postMessage("changed");
  }

  /** Runs one sync, or marks that another is needed when one is already running. */
  sync() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const work = async () => {
      do {
        this.again = false;
        await this.once();
      } while (this.again);
    };
    const locked = typeof navigator !== "undefined" && navigator.locks ? () => navigator.locks.request("callerwhale-sync", work) : work;
    this.running = locked().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async once() {
    if (!this.online) return;
    this.status = "syncing";
    this.emit();
    try {
      if (!this.store) await this.snapshot();
      await this.push();
      await this.pull();
      this.reachable = true;
      this.status = "synced";
      this.error = "";
    } catch (error) {
      this.reachable = !(error instanceof ApiError && error.code === "offline");
      this.status = this.reachable ? "error" : "offline";
      this.error = error.message;
      if (error instanceof ApiError && error.status === 401) this.status = "signed-out";
    }
    if (this.stopped) return;
    this.emit();
    this.channel?.postMessage("changed");
    this.retryWhenUnreachable();
  }

  /** An unreachable server is tried again every few seconds (and when the browser or tab comes back), so the records are never left stale. */
  retryWhenUnreachable() {
    clearTimeout(this.retryTimer);
    if (this.reachable || !this.online || this.stopped) return;
    this.retryTimer = setTimeout(() => this.sync(), 5000);
  }

  async snapshot() {
    const snapshot = await this.api.snapshot();
    this.store = storeFromSnapshot(snapshot, this.extra);
    await this.save();
  }

  /** Looks a lead up on the server and holds what it finds, so a workspace bigger than this device's window can still be searched. */
  async searchLeads(term) {
    const found = await this.api.searchLeads(term);
    if (!this.store) return;
    const leads = { ...this.store.leads };
    for (const lead of found.leads || []) leads[lead.id] = lead;
    this.store = { ...this.store, leads };
    this.emit();
  }

  /** Fetches the workspace's lists again, so a list that was just uploaded shows up without signing in again. */
  async refreshProjects() {
    const projects = await this.api.projects();
    if (!this.store) return;
    this.extra = { ...this.extra, projects };
    this.store = { ...this.store, projects };
    await this.save();
    this.emit();
  }

  async save() {
    const stored = await this.vault.put("store", this.store);
    if (!stored) this.error = "This device is out of space: records are not kept offline, but your pending changes are";
  }

  async push() {
    const pending = this.ops.filter(op => op.status === "Pending");
    for (let start = 0; start < pending.length; start += 100) {
      const batch = pending.slice(start, start + 100);
      // The server needs only the operation; local bookkeeping stays here.
      const wire = batch.map(({ id, kind, payload, claimed_at, queued_offline }) => ({ id, kind, payload, claimed_at, queued_offline, device_id: "browser" }));
      const answer = await this.api.push(wire, this.store?.accessRevision);
      for (const result of answer.results) {
        const op = this.ops.find(item => item.id === result.id);
        if (!op) continue;
        if (result.status === "applied" || (result.status === "duplicate" && result.original_status === "applied")) {
          await this.vault.remove(op.id);
          this.ops = this.ops.filter(item => item.id !== op.id);
        } else {
          const original = result.status === "duplicate" ? result.original_status : result.status;
          const updated = {
            ...op,
            status: original === "conflict" ? "Conflict" : "Rejected",
            message: result.message || result.result?.message || "The server did not apply this change",
            fields: result.result?.fields,
          };
          await this.vault.update(updated);
          this.ops = this.ops.map(item => (item.id === op.id ? updated : item));
        }
      }
      if (answer.reset) this.store = null;
    }
    if (!this.store) {
      await this.vault.dropRecords();
      await this.snapshot();
    }
  }

  async pull() {
    while (true) {
      const answer = await this.api.pull(this.store.cursor, this.store.accessRevision);
      if (answer.reset) {
        // Permissions changed: nothing cached before may be trusted.
        await this.vault.dropRecords();
        await this.snapshot();
        return;
      }
      if (answer.more && answer.cursor === this.store.cursor) throw new Error("The server did not advance the sync cursor");
      this.store = { ...applyChanges(this.store, answer.changes), cursor: answer.cursor };
      await this.save();
      if (!answer.more) return;
    }
  }

  async connect() {
    if (this.socket || this.connecting || typeof WebSocket !== "function") return;
    this.connecting = true;
    const token = await auth.accessToken().catch(() => null);
    this.connecting = false;
    if (this.socket || this.stopped) return;
    let socket;
    try {
      socket = new WebSocket(eventsUrl(), socketProtocols(token));
    } catch {
      return;
    }
    this.socket = socket;
    let timer = null;
    socket.onmessage = message => {
      let event: any = {};
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event.kind === "hello") return;
      if (event.kind === "project.changed") void this.refreshProjects().catch(() => {});
      // Coalesce bursts of changes into one pull.
      clearTimeout(timer);
      timer = setTimeout(() => this.sync(), event.kind === "access.changed" ? 0 : 250);
    };
    socket.onclose = () => {
      this.socket = null;
      if (!this.stopped) setTimeout(() => this.connect(), 5000);
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
    this.channel?.close();
  }
}
