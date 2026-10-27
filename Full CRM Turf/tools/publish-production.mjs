// Builds the production branches (docs/plans/production-branches.md): one branch per part, holding only that part's
// files. Reads tools/production.json, takes the files from `main` (or --from <ref>), and writes each branch as a new
// commit on top of its previous one, so a branch's history is the list of snapshots of main it was made from.
// It never touches the working tree or the index you work with, and never rewrites or force-pushes a branch.
//
//   node tools/publish-production.mjs --list                 what each branch holds
//   node tools/publish-production.mjs                        update every branch (locally)
//   node tools/publish-production.mjs landing-web-production update one
//   node tools/publish-production.mjs --push                 also push what changed to origin
//   TURF_COMMIT_TRAILER="Co-Authored-By: ..." adds a line to the end of each commit message
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Drops `COPY <dir> ./<dir>` lines whose source is not in the branch (a server branch has no desktop/ to copy). */
export function rewriteDockerfile(text, topLevel) {
  return text
    .split("\n")
    .filter(line => {
      const copy = line.match(/^COPY\s+(\S+)\s+\.\/\S+\s*$/);
      return !copy || topLevel.has(copy[1].replace(/\/$/, ""));
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

/** The note at the root of each branch. Named readme.md so GitHub shows it on the branch's page. */
const NOTE = "readme.md";

function note(component, { ref, short, date, files, content }) {
  return `# ${component.title}

This branch is a **production snapshot of one part of Turf**: only the files this part needs, at the same paths as in \`${component.base ?? "Full CRM Turf"}/\` on \`main\`.

- Last changed from \`${ref}\` at \`${short}\` (${date})
- Content id: \`${content}\` (the branch is only refreshed when this changes)
- Holds: ${component.paths.map(p => `\`${p}\``).join(", ")}${component.rust ? ", and the Cargo workspace file and lock for it" : ""}
- ${files} files
- Build and test: ${component.build}

Do not edit it here. Change the code on \`main\`, then refresh the branch from a checkout of \`main\`:

    node tools/publish-production.mjs ${component.name} --push
`;
}

function run() {
  const args = process.argv.slice(2);
  const flag = name => args.includes(name);
  const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : "main";
  const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--from");
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const git = (argv, { env = {}, input } = {}) => execFileSync("git", argv, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
  const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "production.json"), "utf8"));
  const chosen = config.components.filter(c => !names.length || names.includes(c.name));
  if (!chosen.length) throw new Error("No such branch: " + names.join(", "));
  const sha = git(["rev-parse", from]).trim();
  const short = sha.slice(0, 7);
  const date = git(["show", "-s", "--format=%cs", sha]).trim();
  const indexFile = join(git(["rev-parse", "--absolute-git-dir"]).trim(), "turf-production.index");
  const trailer = process.env.TURF_COMMIT_TRAILER ? `\n\n${process.env.TURF_COMMIT_TRAILER}` : "";
  const changed = [];

  for (const component of chosen) {
    rmSync(indexFile, { force: true });
    const env = { GIT_INDEX_FILE: indexFile };
    const base = component.base ?? "Full CRM Turf";
    const at = rel => (rel === "." ? base : base ? `${base}/${rel}` : rel);
    const addPath = (rel, { optional = false } = {}) => {
      const source = `${sha}:${at(rel)}`;
      let type;
      try {
        type = git(["cat-file", "-t", source]).trim();
      } catch {
        if (optional) return;
        throw new Error(`${component.name}: ${rel} is not in ${from}`);
      }
      if (type === "tree") git(["read-tree", ...(rel === "." ? [] : [`--prefix=${rel}/`]), source], { env });
      else {
        const [mode, , blob] = git(["ls-tree", sha, at(rel)]).split("\t")[0].split(" ");
        git(["update-index", "--add", "--cacheinfo", `${mode},${blob},${rel}`], { env });
      }
    };
    const put = (rel, text) => {
      const blob = git(["hash-object", "-w", "--stdin"], { input: text }).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`], { env });
    };
    const listing = () => git(["ls-files"], { env }).split("\n").filter(Boolean);

    git(["read-tree", "--empty"], { env });
    for (const rel of component.paths) addPath(rel);
    addPath(".gitignore", { optional: true });
    if (component.rust) {
      addPath("Cargo.lock");
      const files = listing();
      // A member is there only with its Cargo.toml (a branch can hold other files under the same folder).
      const has = member => Boolean(member) && files.includes(`${member}/Cargo.toml`);
      put("Cargo.toml", pruneWorkspace(git(["show", `${sha}:${at("Cargo.toml")}`]), has));
    }
    const files = listing();
    const topLevel = new Set(files.map(f => f.split("/")[0]));
    for (const dockerfile of files.filter(f => /(^|\/)Dockerfile$/.test(f))) {
      const original = git(["cat-file", "-p", git(["ls-files", "-s", "--", dockerfile], { env }).split(/\s+/)[1]]);
      const rewritten = rewriteDockerfile(original, topLevel);
      if (rewritten !== original) put(dockerfile, rewritten);
    }
    // The branch changes only when its files do, not on every commit to main: compare the files without the note.
    const content = git(["write-tree"], { env }).trim();
    const ref = `refs/heads/${component.name}`;
    let parent = "";
    try {
      parent = git(["rev-parse", "--verify", "-q", ref]).trim();
    } catch {
      parent = "";
    }
    let before = "";
    try {
      before = git(["show", `${parent}:${NOTE}`]).match(/Content id: `([0-9a-f]+)`/)?.[1] ?? "";
    } catch {
      before = "";
    }
    if (parent && before === content) {
      console.log(`${component.name}: up to date`);
      continue;
    }
    put(NOTE, note(component, { ref: from, short, date, files: files.length + 1, content }));
    const tree = git(["write-tree"], { env }).trim();
    if (flag("--list")) {
      console.log(`${component.name}: ${files.length + 1} files  (${component.paths.join(", ")})`);
      continue;
    }
    const message = `${component.title}: production snapshot of main ${short}${trailer}`;
    const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]).trim();
    git(["update-ref", ref, commit, ...(parent ? [parent] : [])]);
    changed.push(component.name);
    console.log(`${component.name}: ${parent ? "updated" : "created"} (${files.length + 1} files)`);
  }
  rmSync(indexFile, { force: true });
  if (flag("--push") && !flag("--list")) {
    const toPush = chosen.map(c => c.name).filter(n => changed.includes(n) || remoteBehind(git, n));
    if (toPush.length) console.log(git(["push", "origin", ...toPush.map(n => `refs/heads/${n}:refs/heads/${n}`)]));
    else console.log("Nothing to push.");
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
