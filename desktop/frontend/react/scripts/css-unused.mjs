// Finds stylesheet rules whose classes appear nowhere in the app (npm run css:unused), and removes them with --write.
// Class names built at runtime ("kind-" + x) are recognised from string fragments ending in "-"; map and chart classes
// come from their libraries and are always kept. Check the result on screen before committing a --write.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import parser from "postcss-selector-parser";

const here = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(here, "..", "src", "crm.css");
const srcDir = path.join(here, "..", "src");
const mode = process.argv[2] === "--write" ? "write" : "dry";
const sources = fs
  .readdirSync(srcDir, { recursive: true })
  .filter(f => /\.(jsx?|mjs|html)$/.test(f))
  .map(f => fs.readFileSync(path.join(srcDir, f), "utf8"))
  .concat(fs.readFileSync(path.join(srcDir, "..", "index.html"), "utf8"));
const text = sources.join("\n");
// every word that could be a class name somewhere in the code
const words = new Set(text.match(/[A-Za-z_][A-Za-z0-9_-]*/g));
// fragments used to build class names at runtime, e.g. "status-" or "kind-"
const prefixes = [...new Set(text.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?=["'`])/g) || [])];
// classes that libraries add themselves (the map and the charts)
const library = cls => /^(leaflet|recharts)-/.test(cls);
const used = cls => words.has(cls) || library(cls) || prefixes.some(p => cls.startsWith(p));

const css = fs.readFileSync(cssPath, "utf8");
const root = postcss.parse(css);
const removed = [];
root.walkRules(rule => {
  if (rule.parent && rule.parent.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
  const keep = [];
  for (const selector of rule.selectors) {
    let alive = true;
    parser(sel => {
      sel.walkClasses(node => {
        if (!used(node.value)) alive = false;
      });
    }).processSync(selector);
    if (alive) keep.push(selector);
    else removed.push(selector);
  }
  if (!keep.length) rule.remove();
  else if (keep.length !== rule.selectors.length) rule.selectors = keep;
});
root.walkAtRules(at => {
  if ((at.name === "media" || at.name === "supports") && !at.nodes.length) at.remove();
});
// keyframes nobody plays
const animations = new Set();
root.walkDecls(/^animation(-name)?$/, decl => decl.value.split(/[\s,]+/).forEach(v => animations.add(v)));
root.walkAtRules(/keyframes$/, at => {
  if (!animations.has(at.params)) {
    removed.push("@keyframes " + at.params);
    at.remove();
  }
});
const out = root.toString();
console.log(JSON.stringify({ before: css.split("\n").length, after: out.split("\n").length, removed: removed.length, sample: removed.slice(0, 60) }, null, 1));
if (mode === "write") fs.writeFileSync(cssPath, out);
