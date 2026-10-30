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
  const real = readFileSync(new URL("../Cargo.toml", import.meta.url), "utf8");
  const pruned = pruneWorkspace(real, member => member === "services/features/leads-map");
  assert.equal([...pruned.matchAll(/^\s+"([^"]+)",?$/gm)].map(m => m[1]).join(), "services/features/leads-map");
});
