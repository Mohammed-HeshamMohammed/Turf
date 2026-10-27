// Copies auth-client.js to the website and the CRM, and firebase-auth-client.js to the CRM (the website gets it in
// its bundle, firebase-web-entry.js), since they cannot import across the repository at run time.
//   node services/auth/clients/sync.mjs           copy it
//   node services/auth/clients/sync.mjs --check   fail if a copy differs (run by the tests)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const remote = join(root, "desktop", "frontend", "react", "src", "remote");
const files = {
  "auth-client.js": [join(root, "services", "core-api", "website", "auth-client.js"), join(remote, "auth-client.js")],
  "firebase-auth-client.js": [join(remote, "firebase-auth-client.js")],
};

const check = process.argv.includes("--check");
let stale = 0;
for (const [name, copies] of Object.entries(files)) {
  const original = readFileSync(join(here, name), "utf8");
  for (const copy of copies) {
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
