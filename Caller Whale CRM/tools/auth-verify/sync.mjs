// Copies the shared token verifier (token.go and token_test.go in this folder) into each Go service that checks sign-in
// tokens. Change the files here, then run: node tools/auth-verify/sync.mjs   (or --check to fail when a copy is stale).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const here = dirname(fileURLToPath(import.meta.url));
export const services = ["services/gateway", "services/crm-core", "services/messaging", "services/features/dialer-sms"];
const check = process.argv.includes("--check");
for (const folder of services) {
  for (const name of ["token.go", "token_test.go"]) {
    const body = readFileSync(resolve(here, name), "utf8");
    const target = resolve(root, folder, name);
    if (check) {
      let current = "";
      try { current = readFileSync(target, "utf8"); } catch {}
      if (current.replace(/\r\n/g, "\n") !== body.replace(/\r\n/g, "\n")) throw new Error(`Stale token verifier: ${folder}/${name}. Run node tools/auth-verify/sync.mjs`);
    } else writeFileSync(target, body);
  }
}
console.log(`${check ? "Checked" : "Synchronized"} the token verifier in ${services.length} service(s).`);
