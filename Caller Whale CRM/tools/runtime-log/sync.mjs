// Each build context carries an identical dependency-free runner source.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const containers = [
 ["landing/web", "Website"], ["landing/dashboard-web", "Dashboard"], ["landing/api", "Landing API"],
 ["services/auth", "Auth", true], ["services/auth-go", "Auth"], ["services/billing", "Billing"],
 ["services/core-api", "Core API", true], ["services/core-api/go", "Core API worker"],
 ["services/gateway", "Gateway"], ["services/grafana-proxy", "Grafana proxy"], ["services/notifications", "Notifications"],
 ["services/features/ai-campaigns", "AI campaigns"], ["services/features/backup-restore", "Backup restore", true],
 ["services/features/crm", "CRM", true], ["services/features/dialer-sms", "Dialer SMS"],
 ["services/features/exports", "Exports"], ["services/features/importing-lists", "Importing lists"],
 ["services/features/leads-map", "Leads map", true], ["services/features/skip-tracing", "Skip tracing"],
];
const source = readFileSync(resolve(root, "tools/runtime-log/main.go"), "utf8");
const check = process.argv.includes("--check");
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
 const copySource = `${rootContext ? folder + "/" : ""}runtime-log/main.go`;
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
 ["scaffold-access.rs.txt", ["services/features/crm/src/access_log.rs", "services/features/leads-map/src/access_log.rs", "services/features/backup-restore/src/access_log.rs"]],
 ["access-log.mjs", ["landing/api/src/access-log.mjs", "services/billing/src/access-log.mjs", "services/features/ai-campaigns/src/access-log.mjs", "services/features/dialer-sms/src/access-log.mjs"]],
 ["access.go", ["services/gateway/access_log.go", "services/grafana-proxy/access_log.go", "services/notifications/access_log.go", "services/auth-go/access_log.go"]],
 ["access.rs.txt", ["services/auth/src/access_log.rs", "services/core-api/rust/crates/api/src/access_log.rs"]],
];
for (const [sourceName, targets] of adapters) {
 const body = readFileSync(resolve(root, "tools/runtime-log", sourceName), "utf8");
 for (const name of targets) {
  const file = resolve(root, name);
  if (check) { if (readFileSync(file, "utf8") !== body) throw new Error(`Stale request adapter: ${name}`); }
  else writeFileSync(file, body);
 }
}
