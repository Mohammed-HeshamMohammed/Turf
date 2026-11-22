// Which parts CI tests (.github/workflows/ci.yml, D377): on a pull request, the parts whose files (or what they depend on) changed;
// a moved file counts at its old place too (--no-renames lists both); everything on a push to main, on a manual run, and when anything under .github/ changed. Prints `parts=["crm-core",...]`.
//
//   EVENT=pull_request BASE=<base sha> node tools/ci-parts.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const S = "services/";
// Shared Go modules (packages/go, step 50+51): a change runs every Go service that imports them.
const GO = "packages/go/";
// The npm workspace (D383): the shared packages and the root lock file the web apps install from.
const NPM = ["packages/", "package.json", "package-lock.json", ".npmrc"];

/** Each part and the path prefixes that make it run. */
export const PARTS = {
  "go-packages": [GO],
  "crm-core": [S + "crm-core/", GO],
  // Its tests run the live server as services/live sets it up, reading the outbox.
  messaging: [S + "messaging/", S + "live/", GO],
  telnyx: [S + "telnyx/", GO],
  auth: [S + "auth/", GO],
  authz: [S + "authz/", GO],
  learning: [S + "learning/"],
  notifications: [S + "notifications/", GO],
  mcp: [S + "mcp/"],
  assistant: [S + "assistant/"],
  // shield_test.go compares the gateway's list with auth's routes.
  gateway: [S + "gateway/", S + "auth/", GO],
  grafana: ["deploy/monitoring/", S + "grafana-proxy/", S + "alert-relay/", GO],
  billing: [S + "billing/"],
  // Their database tests build crm-core's tables from its scripts.
  "importing-lists": [S + "importing-lists/", S + "crm-core/migrations/"],
  "importing-worker": [S + "importing-worker/", S + "crm-core/migrations/"],
  // Also every place a shared file is copied to (the token check, the request-log adapters and runner): the tools job checks that
  // each copy matches its source. It also runs the tests of packages/.
  tools: ["tools/", "deploy/", "env/", S, "packages/", "scaffolds/"],
  "crm-app": ["apps/crm/", "apps/crm-web/", "engines/skip-engine/", ...NPM],
  website: ["apps/website/", ...NPM],
};
// The desktop apps and the engine they ship are not here: they have their own development and their own workflows (desktop.yml,
// older-app.yml), which do not block merging to main.

export function partsFor(files, { all = false } = {}) {
  if (all || files.some(f => f.startsWith(".github/"))) return Object.keys(PARTS);
  return Object.keys(PARTS).filter(part => PARTS[part].some(prefix => files.some(f => f === prefix || f.startsWith(prefix))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { EVENT = "", BASE = "" } = process.env;
  let parts;
  if (EVENT === "pull_request" && BASE) {
    const files = execFileSync("git", ["diff", "--name-only", "--no-renames", `${BASE}...HEAD`], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean);
    parts = partsFor(files);
  } else parts = partsFor([], { all: true });
  console.log(`parts=${JSON.stringify(parts)}`);
}
