// Builds the production branches (docs/operations/production-branches.md): one branch per part, holding only that part's
// files. A component with paths ["."] exports its base folder at the branch root.
// Reads tools/production.json, takes the files from `main` (or --from <ref>), and writes each branch as a new
// commit on top of its previous one, so a branch's history is the list of snapshots of main it was made from.
// It never touches the working tree or the index you work with, and never rewrites or force-pushes a branch.
//
//   node tools/publish-production.mjs --list                 what each branch holds
//   node tools/publish-production.mjs                        update every branch (locally)
//   node tools/publish-production.mjs website-production update one
//   node tools/publish-production.mjs --push                 also push what changed to origin
//   node tools/publish-production.mjs --export <dir> [name]  write each branch's files to <dir>/<name> (for image builds), touch nothing
//   CALLERWHALE_COMMIT_TRAILER="Co-Authored-By: ..." adds a line to the end of each commit message
//
// It refuses a commit whose "CI summary" check on GitHub has not passed (.github/workflows/ci.yml): a branch Coolify deploys
// from never gets code that failed its tests. A branch with `checks` in production.json (the desktop app and the engine: "Desktop
// summary", .github/workflows/desktop.yml) changes only when those passed on the commit too; the other branches go ahead without it. It asks GitHub with the `gh` command. --without-checks skips this, for an emergency
// only, and says so loudly.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Drops `COPY <source> ./<dest>` lines whose source is not in the branch (a server branch has no desktop/ to copy). The
 * source is looked for from the branch root (a Dockerfile built with the whole branch as its context) and from the
 * Dockerfile's own folder `dir` (one built with its folder as the context, like `COPY src ./src` in landing/api).
 */
export function rewriteDockerfile(text, files, dir = "") {
  const has = path => files.some(f => f === path || f.startsWith(path + "/"));
  return text
    .split("\n")
    .filter(line => {
      const copy = line.match(/^COPY\s+(\S+)\s+\.\/\S+\s*$/);
      if (!copy || copy[1].startsWith("--")) return true;
      const source = copy[1].replace(/\/$/, "");
      return has(source) || Boolean(dir && has(`${dir}/${source}`));
    })
    .join("\n");
}

/** The Cargo workspace file with only the members (and excludes) whose folders are in the branch. */
export function pruneWorkspace(text, has) {
  const out = [];
  let inMembers = false;
  for (const line of text.split("\n")) {
    if (/^members\s*=\s*\[\s*$/.test(line)) {
      inMembers = true;
      out.push(line);
      continue;
    }
    if (inMembers) {
      if (/^\]/.test(line)) inMembers = false;
      else if (!has(line.match(/"([^"]+)"/)?.[1])) continue;
      out.push(line);
      continue;
    }
    const exclude = line.match(/^exclude\s*=\s*\[(.*)\]\s*$/);
    if (exclude) {
      const kept = [...exclude[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(has);
      if (kept.length) out.push(`exclude = [${kept.map(k => `"${k}"`).join(", ")}]`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** A path entry as people read it: "a", or "a (as b)" when {from: a, to: b} puts it elsewhere in the branch. */
export function pathLabel(entry) {
  return typeof entry === "string" ? entry : `${entry.from} (as ${entry.to})`;
}

/** The name of the one check `main` requires (ci.yml's last job). */
export const SUMMARY_CHECK = "CI summary";
/** How to get a missing check run on main, by its name. */
const HOW = { "CI summary": "it runs on every push to main", "Desktop summary": "run the Desktop app workflow on main (GitHub, Actions, Desktop app, Run workflow) and wait for it" };

/**
 * Whether a commit may be published, from GitHub's check runs for it ({check_runs: [{id, name, status, conclusion, app}]}). Only
 * runs made by GitHub Actions count (another app could name a check the same). The newest run decides, by id, which GitHub gives
 * in creation order (a queued re-run has no start time yet, but it has an id). Answers {ok, why}.
 */
export function checksVerdict(checkRuns, name = SUMMARY_CHECK) {
  const runs = (checkRuns?.check_runs ?? []).filter(r => r.name === name && r.app?.slug === "github-actions");
  if (!runs.length) return { ok: false, why: `no "${name}" check from GitHub Actions for this commit yet (${HOW[name] ?? "it has not run on it"})` };
  const newest = runs.reduce((a, b) => (b.id > a.id ? b : a));
  if (newest.status !== "completed") return { ok: false, why: `"${name}" is still ${newest.status}; wait for it` };
  if (newest.conclusion !== "success") return { ok: false, why: `"${name}" ended ${newest.conclusion}` };
  return { ok: true, why: `"${name}" passed` };
}

/** Asks GitHub (through `gh`) whether a commit's named check passed. Answers {ok, why}. */
function checkPassed(root, sha, name) {
  try {
    const out = execFileSync("gh", ["api", `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100&check_name=${encodeURIComponent(name)}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return checksVerdict(JSON.parse(out), name);
  } catch (err) {
    return { ok: false, why: `could not ask GitHub (${String(err.stderr || err.message).trim().split("\n")[0]})` };
  }
}

/** The note at the root of each branch. Named readme.md so GitHub shows it on the branch's page. */
const NOTE = "readme.md";

/**
 * The content id a branch was last made with, from its readme's table row (`| Content id | \`<id>\` |`) or, for a branch without a
 * readme, its commit message (`Content id: <id>`). "" when there is none, so the branch is made again.
 */
export function contentIdIn(text) {
  return String(text ?? "").match(/Content id(?::|\s*\|)\s*`?([0-9a-f]{40})/)?.[1] ?? "";
}

export function note(component, { ref, short, date, files, content }) {
  const images = (component.images ?? []).map(i => `| \`${i.name}\` | \`${i.dockerfile}\` | ${i.deploy?.coolify ? `Coolify app \`${i.deploy.coolify}\`${i.deploy.setting ? ` (setting \`${i.deploy.setting}\`)` : ""}` : "not deployed by itself yet"} |`);
  return `# ${component.title}

A **production snapshot of one part of Caller Whale**: only the files this part needs, at the same paths as on \`main\`, so it can be
deployed, handed over or reviewed on its own.

| | |
| --- | --- |
| Made from | \`${ref}\` at \`${short}\` (${date}) |
| Content id | \`${content}\` (the branch changes only when this does) |
| Holds | ${component.paths.map(p => `\`${pathLabel(p)}\``).join(", ")}${component.rust ? ", and the Cargo workspace file and lock for it" : ""} (${files} files) |
| Settings | ${component.envExample ? `\`.env.example\` at the root (from \`${component.envExample}\` on \`main\`): paste into Coolify's Developer View; secrets stay in Coolify` : "none of its own"} |
| Build and test | ${component.build} |
${images.length ? `
## Images

Built by GitHub Actions from this branch's files (\`.github/workflows/images.yml\`), tagged with the content id, and deployed after
the "production" approval when they have a Coolify app.

| Image | Dockerfile | Runs as |
| --- | --- | --- |
${images.join("\n")}
` : ""}
## Do not edit this branch

Change the code on \`main\`; after its CI passes, refresh the branch from a checkout of \`main\`:

    node tools/publish-production.mjs ${component.name} --push
`;
}

function run() {
  const args = process.argv.slice(2);
  const flag = name => args.includes(name);
  const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : "main";
  const exportDir = args.includes("--export") ? args[args.indexOf("--export") + 1] : "";
  const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--from" && args[i - 1] !== "--export");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const git = (argv, { env = {}, input } = {}) => execFileSync("git", argv, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
  const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "production.json"), "utf8"));
  const chosen = config.components.filter(c => !names.length || names.includes(c.name));
  if (!chosen.length) throw new Error("No such branch: " + names.join(", "));
  const sha = git(["rev-parse", from]).trim();
  const short = sha.slice(0, 7);
  const date = git(["show", "-s", "--format=%cs", sha]).trim();
  if (!flag("--list") && !exportDir) {
    if (flag("--without-checks")) console.log(`WARNING: publishing ${short} without looking at its checks (--without-checks).`);
    else {
      const verdict = checkPassed(root, sha, SUMMARY_CHECK);
      if (!verdict.ok) {
        console.error(`Not publishing ${short}: ${verdict.why}.`);
        process.exit(1);
      }
      console.log(`${short}: ${verdict.why}.`);
    }
  }
  const indexFile = join(git(["rev-parse", "--absolute-git-dir"]).trim(), "callerwhale-production.index");
  const trailer = process.env.CALLERWHALE_COMMIT_TRAILER ? `\n\n${process.env.CALLERWHALE_COMMIT_TRAILER}` : "";
  const changed = [];
  const held = [];

  for (const component of chosen) {
    rmSync(indexFile, { force: true });
    const env = { GIT_INDEX_FILE: indexFile };
    const base = component.base ?? "";
    const at = rel => (rel === "." ? base : base ? `${base}/${rel}` : rel);
    // `to` puts the files somewhere else in the branch than on main (a path entry {"from": ..., "to": ...}).
    const addPath = (rel, { optional = false, to = rel } = {}) => {
      const source = `${sha}:${at(rel)}`;
      let type;
      try {
        type = git(["cat-file", "-t", source]).trim();
      } catch {
        if (optional) return;
        throw new Error(`${component.name}: ${rel} is not in ${from}`);
      }
      if (type === "tree") git(["read-tree", ...(to === "." ? [] : [`--prefix=${to}/`]), source], { env });
      else {
        const [mode, , blob] = git(["ls-tree", sha, at(rel)]).split("\t")[0].split(" ");
        git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${to}`], { env });
      }
    };
    const put = (rel, text) => {
      const blob = git(["hash-object", "-w", "--stdin"], { input: text }).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`], { env });
    };
    const listing = () => git(["ls-files"], { env }).split("\n").filter(Boolean);

    git(["read-tree", "--empty"], { env });
    for (const entry of component.paths) typeof entry === "string" ? addPath(entry) : addPath(entry.from, { to: entry.to });
    addPath(".gitignore", { optional: true });
    // A branch root .env.example, copied from the example this part's environment follows (the path is from the repository root).
    if (component.envExample) {
      try {
        put(".env.example", git(["show", `${sha}:${component.envExample}`]));
      } catch {
        console.log(`${component.name}: ${component.envExample} is not in ${from}, no .env.example`);
      }
    }
    // Every branch carries the repository's licence (LICENSE at the root of main).
    try {
      put("LICENSE", git(["show", `${sha}:LICENSE`]));
    } catch {
      /* main has no LICENSE yet */
    }
    // "exclude" drops files that belong on main but not on this branch (e.g. the source folder README).
    for (const rel of component.exclude ?? []) git(["update-index", "--force-remove", rel], { env });
    if (component.rust) {
      // `rust: true`: the Cargo workspace is at the branch root; `rust: "<folder>"`: it is in that folder of the branch.
      const cargo = rel => (typeof component.rust === "string" ? `${component.rust}/${rel}` : rel);
      addPath(cargo("Cargo.lock"));
      const files = listing();
      // A member is there only with its Cargo.toml (a branch can hold other files under the same folder).
      const has = member => Boolean(member) && files.includes(`${cargo(member)}/Cargo.toml`);
      put(cargo("Cargo.toml"), pruneWorkspace(git(["show", `${sha}:${at(cargo("Cargo.toml"))}`]), has));
    }
    const files = listing();
    for (const dockerfile of files.filter(f => /(^|\/)Dockerfile$/.test(f))) {
      const original = git(["cat-file", "-p", git(["ls-files", "-s", "--", dockerfile], { env }).split(/\s+/)[1]]);
      const rewritten = rewriteDockerfile(original, files, dockerfile.split("/").slice(0, -1).join("/"));
      if (rewritten !== original) {
        const kept = new Set(rewritten.split("\n"));
        for (const line of original.split("\n")) if (!kept.has(line)) console.log(`${component.name}: ${dockerfile}: not in this branch, dropped: ${line}`);
        put(dockerfile, rewritten);
      }
    }
    // The branch changes only when its files do, not on every commit to main: compare the files without the note.
    const content = git(["write-tree"], { env }).trim();
    // --export: write the branch's files (without the note) to <dir>/<name> for an image build, and <dir>/<name>.content with the
    // content id; no branch is touched (.github/workflows/images.yml).
    if (exportDir) {
      // An image never holds docs/ (a branch may carry a guide for whoever reads it, e.g. Grafana's), so editing a doc never
      // changes an image's content id and never rebuilds or redeploys it.
      git(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "docs"], { env });
      const imageContent = git(["write-tree"], { env }).trim();
      const out = resolve(exportDir, component.name);
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      // Piped, with the folder as tar's working directory: GNU tar reads "X:\..." as a remote host.
      const archive = execFileSync("git", ["archive", "--format=tar", imageContent], { cwd: root, maxBuffer: 1 << 30 });
      execFileSync("tar", ["-xf", "-"], { cwd: out, input: archive, maxBuffer: 1 << 30 });
      writeFileSync(join(out, "..", `${component.name}.content`), imageContent + "\n");
      console.log(`${component.name}: exported ${imageContent}`);
      continue;
    }
    const ref = `refs/heads/${component.name}`;
    let parent = "";
    try {
      parent = git(["rev-parse", "--verify", "-q", ref]).trim();
    } catch {
      parent = "";
    }
    let before = "";
    try {
      // A branch with "note": false has no readme.md; its content id is kept in the commit message instead.
      before = contentIdIn(component.note === false ? git(["log", "-1", "--format=%B", parent]) : git(["show", `${parent}:${NOTE}`]));
    } catch {
      before = "";
    }
    if (parent && before === content) {
      console.log(`${component.name}: up to date`);
      continue;
    }
    // A branch with its own checks (the desktop app and the engine) changes only once they passed on this commit; the others go on.
    if (component.checks?.length && !flag("--list") && !flag("--without-checks")) {
      const failed = component.checks.map(name => checkPassed(root, sha, name)).find(v => !v.ok);
      if (failed) {
        console.error(`${component.name}: not refreshed: ${failed.why}.`);
        held.push(component.name);
        continue;
      }
    }
    const noted = component.note !== false;
    if (noted) put(NOTE, note(component, { ref: from, short, date, files: files.length + 1, content }));
    const tree = git(["write-tree"], { env }).trim();
    if (flag("--list")) {
      console.log(`${component.name}: ${files.length + (noted ? 1 : 0)} files  (${component.paths.map(pathLabel).join(", ")})`);
      continue;
    }
    const message = `${component.title}: production snapshot of main ${short}${noted ? "" : `

Content id: ${content}`}${trailer}`;
    const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]).trim();
    git(["update-ref", ref, commit, ...(parent ? [parent] : [])]);
    changed.push(component.name);
    console.log(`${component.name}: ${parent ? "updated" : "created"} (${files.length + (noted ? 1 : 0)} files)`);
  }
  rmSync(indexFile, { force: true });
  if (flag("--push") && !flag("--list")) {
    const toPush = chosen.map(c => c.name).filter(n => changed.includes(n) || remoteBehind(git, n));
    if (toPush.length) console.log(git(["push", "origin", ...toPush.map(n => `refs/heads/${n}:refs/heads/${n}`)]));
    else console.log("Nothing to push.");
  }
  if (held.length) {
    console.error(`Held back, waiting for their own checks: ${held.join(", ")}.`);
    process.exitCode = 1;
  }
}

/** True when origin does not have this branch at its current commit. */
function remoteBehind(git, name) {
  try {
    const remote = git(["ls-remote", "--heads", "origin", name]).split("\t")[0];
    return remote !== git(["rev-parse", `refs/heads/${name}`]).trim();
  } catch {
    return true;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
