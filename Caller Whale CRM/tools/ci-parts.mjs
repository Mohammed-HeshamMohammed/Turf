// Which parts CI tests (.github/workflows/ci.yml, D377): on a pull request, the parts whose files (or what they depend on) changed;
// everything on a push to main, on a manual run, and when anything under .github/ changed. Prints `parts=["crm-core",...]`.
//
//   EVENT=pull_request BASE=<base sha> node tools/ci-parts.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const C = "Caller Whale CRM/";
const S = C + "services/";

/** Each part and the path prefixes that make it run. */
export const PARTS = {
  "crm-core": [S + "crm-core/"],
  messaging: [S + "messaging/"],
  "dialer-sms": [S + "features/dialer-sms/"],
  auth: [S + "auth/"],
  authz: [S + "authz/"],
  learning: [S + "learning/"],
  notifications: [S + "notifications/"],
  mcp: [S + "mcp/"],
  assistant: [S + "assistant/"],
  // shield_test.go compares the gateway's list with auth's routes; the token check is a copy of tools/auth-verify.
  gateway: [S + "gateway/", S + "auth/", C + "tools/auth-verify/"],
  grafana: [C + "deploy/grafana/", S + "grafana-proxy/", S + "alert-relay/"],
  billing: [S + "billing/"],
  // The end-to-end test builds crm-core's tables from its scripts.
  "importing-lists": [S + "features/importing-lists/", S + "crm-core/migrations/"],
  tools: [C + "tools/", C + "deploy/", C + "env/", S + "live/"],
  "crm-app": [C + "desktop/frontend/", C + "landing/dashboard-web/", C + "services/auth/clients/", "service/"],
  website: [C + "landing/site/"],
  "skip-engine": ["service/"],
  "desktop-app": [C + "desktop/", C + "Cargo.toml", C + "Cargo.lock", S + "features/", C + "services/auth/clients/", "service/"],
  "older-app": ["Caller Whale App/", "service/"],
};

export function partsFor(files, { all = false } = {}) {
  if (all || files.some(f => f.startsWith(".github/"))) return Object.keys(PARTS);
  return Object.keys(PARTS).filter(part => PARTS[part].some(prefix => files.some(f => f === prefix || f.startsWith(prefix))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { EVENT = "", BASE = "" } = process.env;
  let parts;
  if (EVENT === "pull_request" && BASE) {
    const files = execFileSync("git", ["diff", "--name-only", `${BASE}...HEAD`], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean);
    parts = partsFor(files);
  } else parts = partsFor([], { all: true });
  console.log(`parts=${JSON.stringify(parts)}`);
}
