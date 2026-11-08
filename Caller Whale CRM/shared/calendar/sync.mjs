// Copies the shared calendar (calendar.jsx, calendar.css and its types) to every app that draws dates, since they cannot
// import across the repository at build time.
//   node shared/calendar/sync.mjs           copy it
//   node shared/calendar/sync.mjs --check   fail if a copy differs (run by the tests)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const crm = join(here, "..", "..");
const apps = [
  // [the app's folder, where its copy goes, whether it needs the types]
  [join(crm, "desktop", "frontend", "react"), join("src", "calendar"), false],
  [join(crm, "landing", "site"), join("src", "calendar"), true],
  [join(crm, "..", "Caller Whale App"), join("src", "calendar"), true],
];

const check = process.argv.includes("--check");
const same = (a, b) => a !== null && a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
let stale = 0;
for (const [app, folder, types] of apps) {
  // An app that is not in this checkout (a production branch holds one part) has no copy to keep in step.
  if (!existsSync(join(app, "package.json"))) continue;
  for (const name of ["calendar.jsx", "calendar.css", ...(types ? ["calendar.d.ts"] : [])]) {
    const original = readFileSync(join(here, name), "utf8");
    const copy = join(app, folder, name);
    const current = existsSync(copy) ? readFileSync(copy, "utf8") : null;
    if (same(current, original)) continue;
    if (check) {
      console.error(`out of date: ${copy}`);
      stale++;
    } else {
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, original);
      console.log(`copied to ${copy}`);
    }
  }
}
if (stale) {
  console.error("Run: node shared/calendar/sync.mjs");
  process.exit(1);
}
