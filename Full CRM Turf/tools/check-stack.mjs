// Runs the tests of every service and desktop module in tools/stack.json, and says which ones it could not run.
//
//   node tools/check-stack.mjs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stack = JSON.parse(readFileSync(join(root, "tools", "stack.json"), "utf8"));

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  return { ok: r.status === 0, missing: r.error?.code === "ENOENT" || /not recognized|command not found/i.test(r.stderr || ""), out: (r.stdout || "") + (r.stderr || "") };
}

const results = [];
const add = (name, what, r) => results.push({ name, what, status: r.missing ? "skipped (tool missing)" : r.ok ? "ok" : "FAILED", out: r.out });

for (const s of stack.services) {
  if (s.lang === "ts") add(s.name, "node test", run("node", ["--test", "test/*.test.ts"], join(root, s.dir)));
  if (s.lang === "python") add(s.name, "unittest", run("python", ["-m", "unittest", "discover", "-s", "tests"], join(root, s.dir)));
  if (s.lang === "go") add(s.name, "go test", run("go", ["test", "./..."], join(root, s.dir)));
}
add("rust crates", "cargo test --workspace", run("cargo", ["test", "--workspace", "--quiet"]));

const width = Math.max(...results.map(r => r.name.length));
for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.what.padEnd(24)}  ${r.status}`);
const failed = results.filter(r => r.status === "FAILED");
for (const f of failed) console.log(`\n--- ${f.name} ---\n${f.out}`);
const skipped = results.filter(r => r.status.startsWith("skipped"));
if (skipped.length) console.log(`\n${skipped.length} not run: ${skipped.map(s => s.name).join(", ")}`);
process.exit(failed.length ? 1 : 0);
