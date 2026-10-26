import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The landing site's own database. Nothing else reads it (one service, one database). */
export function openStore(file = ":memory:") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS waitlist (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  const addWaitlist = db.prepare("INSERT OR IGNORE INTO waitlist (email, name, company, tier) VALUES (?, ?, ?, ?)");
  const addMessage = db.prepare("INSERT INTO messages (email, name, message) VALUES (?, ?, ?)");
  return {
    /** True when the address is new, false when it was already on the list. */
    joinWaitlist: v => Number(addWaitlist.run(v.email, v.name, v.company, v.tier).changes) === 1,
    saveMessage: v => void addMessage.run(v.email, v.name, v.message),
    waitlistCount: () => db.prepare("SELECT COUNT(*) AS n FROM waitlist").get().n,
    close: () => db.close(),
  };
}
