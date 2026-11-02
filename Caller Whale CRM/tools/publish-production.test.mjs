// node --test tools/publish-production.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runtimeLogTargets, pruneWorkspace, rewriteDockerfile } from "./publish-production.mjs";

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


test("frontend production branches export runnable contexts at root and retain history", () => {
  const root = mkdtempSync(join(tmpdir(), "callerwhale-publish-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Publisher Test");
    git("config", "user.email", "publisher@example.test");
    const tools = join(root, "tools");
    mkdirSync(tools);
    copyFileSync(new URL("./publish-production.mjs", import.meta.url), join(tools, "publish-production.mjs"));
    const config = JSON.parse(readFileSync(new URL("./production.json", import.meta.url), "utf8"));
    const components = config.components.filter(c => ["landing-web-production", "landing-dashboard-web-production"].includes(c.name));
    assert.equal(components.length, 2);
    writeFileSync(join(tools, "production.json"), JSON.stringify({ components }));
    for (const c of components) {
      assert.deepEqual(c.paths, ["."]);
      const source = join(root, c.base);
      mkdirSync(join(source, "src"), { recursive: true });
      for (const file of ["Dockerfile", "package.json", "package-lock.json", "nginx.conf", ".dockerignore", ".gitignore"]) {
        copyFileSync(new URL(`../${c.base.replace("Caller Whale CRM/", "")}/${file}`, import.meta.url), join(source, file));
      }
      writeFileSync(join(source, "src/main.jsx"), "initial source");
    }
    const runner = join(root, "Caller Whale CRM/tools/runtime-log/main.go");
    mkdirSync(join(root, "Caller Whale CRM/tools/runtime-log"), { recursive: true });
    copyFileSync(new URL("./runtime-log/main.go", import.meta.url), runner);
    git("add", ".");
    git("commit", "-m", "Source fixtures");
    const publish = () => execFileSync(process.execPath, [join(tools, "publish-production.mjs")], { cwd: root, encoding: "utf8" });
    publish();
    for (const c of components) {
      const files = git("ls-tree", "-r", "--name-only", c.name).trim().split("\n");
      for (const required of ["Dockerfile", "package.json", "package-lock.json", "nginx.conf", ".dockerignore", "src/main.jsx", "runtime-log/main.go"]) assert.ok(files.includes(required), `${c.name}: ${required}`);
      assert.equal(git("show", `${c.name}:runtime-log/main.go`), readFileSync(runner, "utf8"));
      assert.ok(files.every(f => !f.startsWith("landing/")), "no nested build context");
      assert.equal(git("show", `${c.name}:Dockerfile`), readFileSync(join(root, c.base, "Dockerfile"), "utf8"));
    }
    const c = components[0];
    const before = git("rev-parse", c.name).trim();
    publish();
    assert.equal(git("rev-parse", c.name).trim(), before, "unchanged publication is idempotent");
    writeFileSync(join(root, c.base, "src/main.jsx"), "updated source");
    git("add", "."); git("commit", "-m", "Update source");
    publish();
    assert.equal(git("rev-parse", `${c.name}^`).trim(), before, "refresh appends without rewriting");
    assert.equal(git("show", `${c.name}:src/main.jsx`), "updated source");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production snapshots inject a runner only for opted-in image contexts", () => {
  assert.deepEqual(runtimeLogTargets([
    ["Dockerfile", "FROM golang:1 AS runtime-log-build"],
    ["services/core-api/Dockerfile", "FROM golang:1 AS runtime-log-build"],
    ["vendor/Dockerfile", "FROM redis:7"],
  ]), ["runtime-log/main.go", "services/core-api/runtime-log/main.go"]);
});
