import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judge, main, parseArgs } from "./restore-test.mjs";

test("the arguments need a dump and a scratch database", () => {
  assert.throws(() => parseArgs(["--dump", "x.dmp"]), /scratch/);
  assert.throws(() => parseArgs(["--dump", "x.dmp", "--scratch", "mysql://x"]), /postgres/);
  assert.deepEqual(parseArgs(["--dump", "x.dmp", "--scratch", "postgres://h/db", "--expect", "crm.leads"]).expect, ["crm.leads"]);
});

test("a backup passes with recent rows and the expected tables", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  assert.equal(judge({ counts: { "crm.leads": 3 }, newest: new Date("2026-11-18T01:00:00Z") }, ["crm.leads"], 2, now).ok, true);
  const stale = judge({ counts: { "crm.leads": 3 }, newest: new Date("2026-11-10T01:00:00Z") }, [], 2, now);
  assert.equal(stale.ok, false);
  assert.match(stale.problems[0], /older than 2 days/);
  assert.deepEqual(judge({ counts: { "crm.leads": 0 }, newest: null }, ["crm.tasks"], 2, now).problems.length, 3);
});

// With RESTORE_TEST_ADMIN_URL (a PostgreSQL superuser URL) and PG_BIN, a real dump is made and restored.
test("a real dump restores into the scratch database", { skip: !process.env.RESTORE_TEST_ADMIN_URL }, () => {
  const admin = process.env.RESTORE_TEST_ADMIN_URL;
  const bin = name => (process.env.PG_BIN ? join(process.env.PG_BIN, name) : name);
  const psql = (url, query) => { const r = spawnSync(bin("psql"), ["-X", "-q", "-d", url, "-c", query], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  const db = name => admin.replace(/\/[^/]*$/, `/${name}`);
  for (const name of ["restore_src", "restore_scratch"]) { psql(admin, `DROP DATABASE IF EXISTS ${name}`); psql(admin, `CREATE DATABASE ${name}`); }
  psql(db("restore_src"), "CREATE SCHEMA crm; CREATE TABLE crm.leads (id int PRIMARY KEY, created_at timestamptz DEFAULT now()); INSERT INTO crm.leads (id) VALUES (1), (2)");
  const dir = mkdtempSync(join(tmpdir(), "restore-"));
  try {
    const file = join(dir, "pg-dump-restore_src.dmp");
    const dumped = spawnSync(bin("pg_dump"), ["--format=custom", "--no-owner", "-f", file, db("restore_src")], { encoding: "utf8" });
    assert.equal(dumped.status, 0, dumped.stderr);
    psql(db("restore_scratch"), "CREATE TABLE leftover (x int)");
    assert.equal(main(["--dump", file, "--scratch", db("restore_scratch"), "--expect", "crm.leads"]), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
