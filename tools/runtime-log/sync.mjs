// The deployed images build the log wrapper from packages/go/runtimelog (step 50+51); --check makes sure each still starts
// through it. The scaffolds (scaffolds/*, D384, never deployed or built by CI) still get a generated copy of the wrapper and of
// their request adapters.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const images = [
 ["apps/website", "Landing"], ["apps/crm-web", "Dashboard"],
 ["services/auth", "Auth"], ["services/authz", "Authorization"], ["services/billing", "Billing"],
 ["services/gateway", "Gateway"], ["services/mcp", "MCP"], ["services/crm-core", "CRM core"], ["services/assistant", "Assistant"],
 ["services/grafana-proxy", "Grafana proxy"], ["services/alert-relay", "Alert relay"], ["services/notifications", "Notifications"],
 ["services/live", "Live server"], ["services/telnyx", "Dialer SMS"], ["services/importing-lists", "Importing lists"],
 ["services/importing-worker", "Importing worker"], ["services/crm-core", "CRM merge", "Dockerfile.merge"], ["services/crm-core", "CRM outbox", "Dockerfile.outbox"], ["services/telnyx", "Telnyx phone API", "Dockerfile.phone-api"], ["services/telnyx", "Telnyx phone webhooks", "Dockerfile.phone-webhooks"], ["services/telnyx", "Telnyx phone jobs", "Dockerfile.phone-jobs"], ["services/telnyx", "Telnyx SMS API", "Dockerfile.sms-api"], ["services/telnyx", "Telnyx SMS webhooks", "Dockerfile.sms-webhooks"], ["services/telnyx", "Telnyx SMS jobs", "Dockerfile.sms-jobs"],
 ["services/messaging", "Messaging"], ["services/learning", "Learning"],
];
export const containers = [
 ["scaffolds/ai-campaigns", "AI campaigns"], ["scaffolds/backup-restore", "Backup restore", true],
 ["scaffolds/crm", "CRM", true], ["scaffolds/exports", "Exports"],
 ["scaffolds/leads-map", "Leads map", true], ["scaffolds/skip-tracing", "Skip tracing"],
];
const source = readFileSync(resolve(root, "packages/go/runtimelog/cmd/callerwhale-log/main.go"), "utf8");
const check = process.argv.includes("--check");
for (const [folder, service, file = "Dockerfile"] of images) {
 const docker = readFileSync(resolve(root, folder, file), "utf8");
 if (!docker.includes("COPY packages/go/runtimelog /src") || !docker.includes("./cmd/callerwhale-log") || !docker.includes('callerwhale-log"') || !docker.includes(`CALLERWHALE_LOG_SERVICE="${service}"`))
  throw new Error(`${folder}/${file} must build the log wrapper from packages/go/runtimelog and start through it as "${service}"`);
}
for (const [folder, service, rootContext] of containers) {
 const base = resolve(root, folder), target = resolve(base, "runtime-log/main.go");
 if (check) {
  if (readFileSync(target, "utf8") !== source) throw new Error(`Run runtime-log/sync.mjs: ${folder}`);
  const docker = readFileSync(resolve(base, "Dockerfile"), "utf8");
  if (!docker.includes('ENTRYPOINT ["/usr/local/bin/callerwhale-log"') || !docker.includes(`CALLERWHALE_LOG_SERVICE="${service}"`)) throw new Error(`Missing log runner: ${folder}`);
  continue;
 }
 mkdirSync(dirname(target), { recursive:true }); writeFileSync(target, source);
 const file = resolve(base, "Dockerfile"); let docker = readFileSync(file, "utf8");
 if (docker.includes("AS runtime-log-build")) continue;
 const copySource = `${rootContext ? folder.replace(/^scaffolds\//, "") + "/" : ""}runtime-log/main.go`;
 const stage = `FROM golang:1 AS runtime-log-build\nCOPY ${copySource} /src/main.go\nRUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /runtime-log /src/main.go\n\n`;
 const first = docker.indexOf("FROM "); docker = docker.slice(0, first) + stage + docker.slice(first);
 const lastFromEnd = docker.indexOf("\n", docker.lastIndexOf("FROM ")) + 1;
 docker = docker.slice(0, lastFromEnd) + `COPY --from=runtime-log-build /runtime-log /usr/local/bin/callerwhale-log\nENV CALLERWHALE_LOG_SERVICE="${service}"\n` + docker.slice(lastFromEnd);
 if (/^ENTRYPOINT /m.test(docker)) docker = docker.replace(/^ENTRYPOINT (\[.*\])$/m, (_, args) => `ENTRYPOINT ${JSON.stringify(["/usr/local/bin/callerwhale-log", ...JSON.parse(args)])}`);
 else docker += '\nENTRYPOINT ["/usr/local/bin/callerwhale-log"]\n';
 if (docker.includes("FROM python:")) docker += "ENV PYTHONUNBUFFERED=1\n";
 writeFileSync(file, docker);
}
console.log(`${check ? "Checked" : "Synchronized"} ${containers.length} application build contexts.`);

const adapters = [
 ["scaffold-access.rs.txt", ["scaffolds/crm/src/access_log.rs", "scaffolds/leads-map/src/access_log.rs", "scaffolds/backup-restore/src/access_log.rs"]],
 ["access-log.mjs", ["scaffolds/ai-campaigns/src/access-log.mjs"]],
];
for (const [sourceName, targets] of adapters) {
 const body = readFileSync(resolve(root, "tools/runtime-log", sourceName), "utf8");
 for (const name of targets) {
  const file = resolve(root, name);
  if (check) { if (readFileSync(file, "utf8") !== body) throw new Error(`Stale request adapter: ${name}`); }
  else writeFileSync(file, body);
 }
}
