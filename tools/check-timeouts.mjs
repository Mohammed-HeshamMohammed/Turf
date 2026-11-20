// Every call one service makes to another has a timeout (the service-isolation rule: one slow or stuck service must not hang the
// ones that call it). Finds, in the Go services and shared modules (tests excluded), the ways Go makes a request with no time
// limit: http.DefaultClient, the http.Get/Post/Head/PostForm helpers (which use it), and an http.Client with no Timeout field.
//   node tools/check-timeouts.mjs    exits 1 and names each place
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const RULES = [
  [/\bhttp\.DefaultClient\b/, "http.DefaultClient has no timeout"],
  [/\bhttp\.(Get|Post|Head|PostForm)\(/, "http.Get/Post/Head/PostForm use http.DefaultClient, which has no timeout"],
  [/http\.Client\{\s*\}/, "an http.Client with no Timeout"],
];

/** The problems in one Go file's text: [{line, why}]. An http.Client literal that spans lines is checked up to its brace. */
export function problems(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const [re, why] of RULES) if (re.test(code)) found.push({ line: i + 1, why });
    const open = code.match(/http\.Client\{(?!\s*\})/);
    if (open) {
      let body = code.slice(open.index);
      for (let j = i + 1; !body.includes("}") && j < lines.length; j++) body += lines[j];
      if (!/\bTimeout\s*:/.test(body.slice(0, body.indexOf("}") + 1))) found.push({ line: i + 1, why: "an http.Client with no Timeout" });
    }
  });
  return found;
}

function goFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...goFiles(path));
    else if (name.endsWith(".go") && !name.endsWith("_test.go")) out.push(path);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = join(fileURLToPath(new URL("..", import.meta.url)));
  const bad = [];
  for (const top of ["services", join("packages", "go")]) {
    for (const file of goFiles(join(repo, top))) {
      for (const p of problems(readFileSync(file, "utf8"))) bad.push(`${relative(repo, file).replace(/\\/g, "/")}:${p.line}: ${p.why}`);
    }
  }
  if (bad.length) {
    console.error(`Calls to other services need a timeout:\n${bad.join("\n")}`);
    process.exit(1);
  }
  console.log("Every outgoing HTTP call in the Go services has a timeout.");
}
