// node --test tools/publish-production.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pruneWorkspace, rewriteDockerfile, checksVerdict, pathLabel, contentIdIn, note } from "./publish-production.mjs";

test("the content id is read back from the branch's own readme and from a commit message, so an unchanged branch is left alone", () => {
  const id = "073d87413114f8b88460cdb29925fcfa1d3d51a4";
  const readme = note({ title: "Website", paths: ["apps/website"], build: "npm test" }, { ref: "main", short: "e8966c3", date: "2026-11-23", files: 3, content: id });
  assert.equal(contentIdIn(readme), id);
  assert.equal(contentIdIn(`Desktop app: production snapshot of main e8966c3\n\nContent id: ${id}`), id);
  assert.equal(contentIdIn(`Content id: \`${id}\``), id);
  assert.equal(contentIdIn("no id here"), "");
  assert.equal(contentIdIn(undefined), "");
});

const cargo = `# One workspace.
[workspace]
resolver = "2"
members = [
  "services/auth",
  "services/auth/verify",
  "scaffolds/crm",
  "desktop/backend/features/crm",
]
exclude = ["desktop/container/rust", "services/core-api/rust"]
`;

test("a Rust server branch keeps only the workspace members it holds", () => {
  const files = ["services/auth/Cargo.toml", "services/auth/verify/Cargo.toml", "services/auth/src/lib.rs"];
  const has = member => Boolean(member) && files.includes(`${member}/Cargo.toml`);
  const pruned = pruneWorkspace(cargo, has);
  assert.match(pruned, /"services\/auth",\n  "services\/auth\/verify",\n\]/);
  assert.doesNotMatch(pruned, /features\/crm/);
  assert.doesNotMatch(pruned, /exclude/, "nothing excluded is in the branch, so no exclude line");
  assert.match(pruned, /^# One workspace\.\n\[workspace\]\nresolver = "2"/);
  // The desktop modules keep their own members, and the excludes that are present.
  const desktop = pruneWorkspace(cargo, member => member?.startsWith("desktop/"));
  assert.match(desktop, /"desktop\/backend\/features\/crm"/);
  assert.doesNotMatch(desktop, /services\/auth/);
  assert.match(desktop, /exclude = \["desktop\/container\/rust"\]/);
});

const lines = (...parts) => parts.join("\n");

test("a Dockerfile stops copying folders the branch does not have", () => {
  const dockerfile = lines("FROM rust:1", "COPY Cargo.toml Cargo.lock ./", "COPY services ./services", "COPY desktop ./desktop", "RUN cargo build");
  const files = ["Cargo.toml", "Cargo.lock", "services/auth/Dockerfile", "services/auth/src/main.rs"];
  assert.equal(rewriteDockerfile(dockerfile, files, "services/auth"), lines("FROM rust:1", "COPY Cargo.toml Cargo.lock ./", "COPY services ./services", "RUN cargo build"));
  assert.equal(rewriteDockerfile(dockerfile, [...files, "desktop/x"], "services/auth"), dockerfile, "nothing is dropped when it is all there");
});

test("a Dockerfile built from its own folder keeps the copies that are there (landing/api's `COPY src ./src`)", () => {
  const dockerfile = lines("FROM node:24-slim", "COPY package.json ./", "COPY src ./src", "COPY assets ./assets", 'CMD ["node", "src/server.mjs"]');
  const files = ["landing/api/Dockerfile", "landing/api/package.json", "landing/api/src/server.mjs"];
  assert.equal(rewriteDockerfile(dockerfile, files, "landing/api"), lines("FROM node:24-slim", "COPY package.json ./", "COPY src ./src", 'CMD ["node", "src/server.mjs"]'), "src stays, the missing assets goes");
});

test("a copy of a nested folder, and COPY with flags, are left alone when the folder is there", () => {
  const dockerfile = lines("COPY services/auth/verify ./services/auth/verify", "COPY --from=build /out/x ./x", "COPY services/core-api/website /srv/website");
  const files = ["services/core-api/Dockerfile", "services/auth/verify/Cargo.toml", "services/core-api/website/app.js"];
  assert.equal(rewriteDockerfile(dockerfile, files, "services/core-api"), dockerfile);
});

test("the real workspace file prunes to its members", () => {
  const real = readFileSync(new URL("../scaffolds/Cargo.toml", import.meta.url), "utf8");
  const pruned = pruneWorkspace(real, member => member === "leads-map");
  assert.equal([...pruned.matchAll(/^\s+"([^"]+)",?$/gm)].map(m => m[1]).join(), "leads-map");
});


test("only a commit whose CI summary passed is published", () => {
  let id = 0;
  const run = (status, conclusion, slug = "github-actions") => ({ id: ++id, name: "CI summary", status, conclusion, app: { slug } });
  assert.equal(checksVerdict({ check_runs: [] }).ok, false);
  assert.equal(checksVerdict({ check_runs: [{ ...run("completed", "success"), name: "something else" }] }).ok, false);
  assert.equal(checksVerdict({ check_runs: [run("in_progress", null)] }).ok, false);
  assert.equal(checksVerdict({ check_runs: [run("completed", "failure")] }).ok, false);
  assert.equal(checksVerdict({ check_runs: [run("completed", "success")] }).ok, true);
  // A re-run that passed replaces the earlier failure, and the other way round; a queued re-run (no start time) holds it back.
  assert.equal(checksVerdict({ check_runs: [run("completed", "failure"), run("completed", "success")] }).ok, true);
  assert.equal(checksVerdict({ check_runs: [run("completed", "success"), run("completed", "failure")] }).ok, false);
  assert.equal(checksVerdict({ check_runs: [run("completed", "success"), run("queued", null)] }).ok, false);
  // A check of the same name from another app does not count.
  assert.equal(checksVerdict({ check_runs: [run("completed", "success", "someone-else")] }).ok, false);
  assert.equal(checksVerdict({ check_runs: [run("completed", "failure"), run("completed", "success", "someone-else")] }).ok, false);
  // Another check by name (the desktop branches' "Desktop summary").
  const desktop = { id: ++id, name: "Desktop summary", status: "completed", conclusion: "success", app: { slug: "github-actions" } };
  assert.equal(checksVerdict({ check_runs: [desktop] }, "Desktop summary").ok, true);
  assert.equal(checksVerdict({ check_runs: [desktop] }).ok, false);
  assert.match(checksVerdict({ check_runs: [] }, "Desktop summary").why, /Run workflow/);
});

test("a path entry can put a folder elsewhere in the branch, and reads that way", () => {
  assert.equal(pathLabel("services/gateway"), "services/gateway");
  assert.equal(pathLabel({ from: "deploy/monitoring", to: "deploy/grafana" }), "deploy/monitoring (as deploy/grafana)");
});
