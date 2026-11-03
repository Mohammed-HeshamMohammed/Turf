// Copies auth-client.js to the website, the CRM and the landing site, since they cannot import across the repository at
// run time.
//   node services/auth/clients/sync.mjs           copy it
//   node services/auth/clients/sync.mjs --check   fail if a copy differs (run by the tests)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const remote = join(root, "desktop", "frontend", "react", "src", "remote");
const files = {
  "human-check.jsx": [join(remote, "human-check.jsx"), join(root, "landing", "web", "src", "auth", "human-check.jsx")],
  "auth-client.js": [join(root, "services", "core-api", "website", "auth-client.js"), join(remote, "auth-client.js"), join(root, "landing", "web", "src", "auth", "auth-client.js")],
};

const check = process.argv.includes("--check");
let stale = 0;
for (const [name, copies] of Object.entries(files)) {
  const original = readFileSync(join(here, name), "utf8");
  for (const copy of copies) {
    // A part that is not in this checkout (a production branch holds one part) has no copy to keep in step.
    if (!existsSync(dirname(copy))) continue;
    let current = null;
    try {
      current = readFileSync(copy, "utf8");
    } catch {
      current = null;
    }
    if (current === original) continue;
    if (check) {
      console.error(`out of date: ${copy}`);
      stale++;
    } else {
      writeFileSync(copy, original);
      console.log(`copied to ${copy}`);
    }
  }
}
if (stale) {
  console.error("Run: node services/auth/clients/sync.mjs");
  process.exit(1);
}
