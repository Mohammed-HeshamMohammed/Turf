// node --test tools/publish-production.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pruneWorkspace, rewriteDockerfile } from "./publish-production.mjs";

const cargo = `# One workspace.
[workspace]
resolver = "2"
members = [
  "services/auth",
  "services/auth/verify",
  "services/features/crm",
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

test("a Dockerfile stops copying folders the branch does not have", () => {
  const dockerfile = ["FROM rust:1", "COPY Cargo.toml Cargo.lock ./", "COPY services ./services", "COPY desktop ./desktop", "RUN cargo build"].join("\n");
  const out = rewriteDockerfile(dockerfile, new Set(["Cargo.toml", "Cargo.lock", "services"]));
  assert.equal(out, ["FROM rust:1", "COPY Cargo.toml Cargo.lock ./", "COPY services ./services", "RUN cargo build"].join("\n"));
  assert.equal(rewriteDockerfile(dockerfile, new Set(["services", "desktop"])), dockerfile, "nothing is dropped when it is all there");
});

test("the real workspace file prunes to its members", () => {
  const real = readFileSync(new URL("../Cargo.toml", import.meta.url), "utf8");
  const pruned = pruneWorkspace(real, member => member === "services/features/leads-map");
  assert.equal([...pruned.matchAll(/^\s+"([^"]+)",?$/gm)].map(m => m[1]).join(), "services/features/leads-map");
});
