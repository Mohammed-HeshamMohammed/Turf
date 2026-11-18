#!/usr/bin/env node
// Build step 41 (D296): the monthly restore test. Restores one backup into a scratch database with PostgreSQL's own tools and checks it
// holds data, recent data, and the tables you name. Prints a report, appends it to a log, and exits non-zero when it fails.
//
//   node tools/restore-test.mjs --dump <file.dmp|.dump|.sql|.sql.gz> --scratch <postgres URL of an empty, throwaway database>
//        [--expect crm.leads --expect crm.tasks] [--max-age-days 2] [--log restore-tests.jsonl]
//
// The backups are Coolify's scheduled database backups (custom-format pg_dump files) or any pg_dump file. The scratch database is
// wiped first: never point --scratch at a live database. PG_BIN may name the folder of pg_restore and psql.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";

export function parseArgs(argv) {
  const out = { expect: [], maxAgeDays: 2, log: "" };
  for (let i = 0; i < argv.length; i++) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === "--dump") out.dump = value;
    else if (key === "--scratch") out.scratch = value;
    else if (key === "--expect") out.expect.push(value);
    else if (key === "--max-age-days") out.maxAgeDays = Number(value);
    else if (key === "--log") out.log = value;
    else continue;
    i++;
  }
  if (!out.dump || !out.scratch) throw new Error("Give --dump <backup file> and --scratch <throwaway database URL>.");
  if (!/^postgres(ql)?:\/\//.test(out.scratch)) throw new Error("--scratch is a postgres:// URL.");
  if (!(out.maxAgeDays > 0)) throw new Error("--max-age-days is a positive number.");
  return out;
}

const tool = name => (process.env.PG_BIN ? join(process.env.PG_BIN, name) : name);

function run(name, args, input) {
  const result = spawnSync(tool(name), args, { input, encoding: "utf8", maxBuffer: 64 << 20 });
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${name} failed: ${(result.stderr || "").trim().split("\n").slice(-3).join(" ")}`);
  return result.stdout;
}

const sql = (scratch, query) => run("psql", ["--no-psqlrc", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-d", scratch, "-c", query]);

/** Empties the scratch database: every schema but PostgreSQL's own. */
function wipe(scratch) {
  const schemas = sql(scratch, `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const schema of schemas) sql(scratch, `DROP SCHEMA IF EXISTS "${schema.replaceAll('"', '""')}" CASCADE`);
  sql(scratch, "CREATE SCHEMA IF NOT EXISTS public");
}

function restore(dump, scratch) {
  if (/\.sql(\.gz)?$/.test(dump)) {
    const text = dump.endsWith(".gz") ? gunzipSync(readFileSync(dump)).toString("utf8") : readFileSync(dump, "utf8");
    run("psql", ["--no-psqlrc", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", scratch], text);
  } else {
    run("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", scratch, dump]);
  }
}

/** Every table's rows, and the newest time in any created/updated/at column. */
function inspect(scratch) {
  const tables = sql(scratch, `SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' ORDER BY 1`).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const counts = {};
  let newest = null;
  for (const table of tables) {
    const [schema, name] = table.split(".");
    const quoted = `"${schema.replaceAll('"', '""')}"."${name.replaceAll('"', '""')}"`;
    counts[table] = Number(sql(scratch, `SELECT count(*) FROM ${quoted}`).trim());
    const timeColumns = sql(scratch, `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema.replaceAll("'", "''")}' AND table_name = '${name.replaceAll("'", "''")}'
      AND data_type LIKE 'timestamp%' AND column_name IN ('created_at', 'updated_at', 'at', 'occurred_at', 'received_at')`).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const column of timeColumns) {
      const value = sql(scratch, `SELECT max("${column}") FROM ${quoted}`).trim();
      if (value && (!newest || new Date(value) > newest)) newest = new Date(value);
    }
  }
  return { counts, newest };
}

export function judge({ counts, newest }, expect, maxAgeDays, now = new Date()) {
  const problems = [];
  const tables = Object.keys(counts);
  const rows = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!tables.length) problems.push("no tables came back");
  if (!rows) problems.push("every table is empty");
  for (const table of expect) if (!(table in counts)) problems.push(`${table} is missing`);
  if (!newest) problems.push("no row has a time to show how recent the backup is");
  else if ((now - newest) / 86400000 > maxAgeDays) problems.push(`the newest row is from ${newest.toISOString()}, older than ${maxAgeDays} days`);
  return { ok: problems.length === 0, tables: tables.length, rows, newest: newest?.toISOString() ?? null, problems };
}

export function main(argv) {
  const args = parseArgs(argv);
  const started = new Date();
  wipe(args.scratch);
  restore(args.dump, args.scratch);
  const verdict = judge(inspect(args.scratch), args.expect, args.maxAgeDays);
  const report = { at: started.toISOString(), dump: basename(args.dump), seconds: Math.round((Date.now() - started) / 1000), ...verdict };
  if (args.log) appendFileSync(args.log, JSON.stringify(report) + "\n");
  console.log(`${report.ok ? "PASS" : "FAIL"} ${report.dump}: ${report.tables} tables, ${report.rows} rows, newest ${report.newest ?? "none"}, ${report.seconds}s`);
  for (const problem of report.problems) console.log(`  - ${problem}`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 2; }
}
