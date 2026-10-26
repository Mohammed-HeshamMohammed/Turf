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
    CREATE TABLE IF NOT EXISTS hits (
      day TEXT NOT NULL,
      path TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, path)
    );
  `);
  if (!db.prepare("PRAGMA table_info(waitlist)").all().some(c => c.name === "plan")) {
    db.exec("ALTER TABLE waitlist ADD COLUMN plan TEXT NOT NULL DEFAULT ''");
  }
  const addHit = db.prepare(
    "INSERT INTO hits (day, path, count) VALUES (date('now'), ?, 1) ON CONFLICT (day, path) DO UPDATE SET count = count + 1",
  );
  const addWaitlist = db.prepare("INSERT OR IGNORE INTO waitlist (email, name, company, tier, plan) VALUES (?, ?, ?, ?, ?)");
  const addMessage = db.prepare("INSERT INTO messages (email, name, message) VALUES (?, ?, ?)");
  return {
    /** True when the address is new, false when it was already on the list. */
    joinWaitlist: v => Number(addWaitlist.run(v.email, v.name, v.company, v.tier, v.plan).changes) === 1,
    saveMessage: v => void addMessage.run(v.email, v.name, v.message),
    recordHit: path => void addHit.run(path),
    /** Page views per page for the last `days` days. */
    hitSummary: days =>
      db
        .prepare("SELECT path, SUM(count) AS views FROM hits WHERE day >= date('now', ?) GROUP BY path ORDER BY views DESC")
        .all(`-${Number(days)} days`)
        .map(r => ({ path: r.path, views: Number(r.views) })),
    waitlistPlans: () =>
      db
        .prepare("SELECT email, tier, plan FROM waitlist WHERE plan <> '' ORDER BY created_at DESC")
        .all()
        .map(r => ({ email: r.email, tier: r.tier, plan: r.plan })),
    waitlistCount: () => db.prepare("SELECT COUNT(*) AS n FROM waitlist").get().n,
    close: () => db.close(),
  };
}
