// Creates the settings files in env/ from their examples, with new random secrets, and never overwrites one that
// exists. Run again after an example gains a setting: it lists what each file is missing.
//   node tools/env-init.mjs
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = join(dirname(fileURLToPath(import.meta.url)), "..", "env");

/**
 * An Ed25519 key for AUTH_SIGNING_KEY: base64 of PKCS#8 v2 (RFC 8410, with the public key), which is what the auth
 * service's `ring` reads. Node writes v1, so the public key is added here.
 */
export function signingKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const der = Buffer.concat([Buffer.from("3053020101300506032b657004220420", "hex"), seed, Buffer.from("a123032100", "hex"), raw]);
  return der.toString("base64");
}

const token = () => randomBytes(32).toString("hex");

/** The settings a file sets (KEY=...), ignoring comments. */
const keys = text => text.split(/\r?\n/).map(line => line.match(/^([A-Z0-9_]+)=/)?.[1]).filter(Boolean);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // One worker token, shared by the API and the worker.
  const password = () => randomBytes(24).toString("hex");
  const shared = { __WORKER_TOKEN__: token(), __DB_OWNER_PASSWORD__: password(), __DB_API_PASSWORD__: password(), __DB_AUTH_PASSWORD__: password() };
  // Where the apps reach each private database inside Coolify's network.
  shared.__CORE_DB_HOST__ = process.env.CALLERWHALE_CORE_DB_HOST || "callerwhale-postgres";
  shared.__AUTH_DB_HOST__ = process.env.CALLERWHALE_AUTH_DB_HOST || "callerwhale-auth-postgres";
  // A newly added SQL template must reuse passwords from an existing database.env.
  const databaseEnv = join(env, "database.env");
  if (existsSync(databaseEnv)) {
    const current = readFileSync(databaseEnv, "utf8");
    for (const [placeholder, key] of [["__DB_OWNER_PASSWORD__", "CORE_API_DATABASE_SETUP_URL"], ["__DB_API_PASSWORD__", "CORE_API_DATABASE_URL"], ["__DB_AUTH_PASSWORD__", "AUTH_DATABASE_URL"]]) {
      const line = current.split(/\r?\n/).find(line => line.startsWith(`${key}=`));
      if (line) shared[placeholder] = new URL(line.slice(key.length + 1)).password;
    }
  }
  for (const example of readdirSync(env).filter(name => name.endsWith(".example"))) {
    const target = join(env, example.replace(/\.example$/, ""));
    const template = readFileSync(join(env, example), "utf8");
    if (!existsSync(target)) {
      const text = Object.entries(shared)
        .reduce((out, [name, value]) => out.replaceAll(name, value), template)
        .replace(/__SECRET__/g, () => token())
        .replace(/__SIGNING_KEY__/g, () => signingKey());
      writeFileSync(target, text);
      console.log(`created env/${example.replace(/\.example$/, "")}`);
      continue;
    }
    if (!example.endsWith(".env.example")) continue;
    const have = new Set(keys(readFileSync(target, "utf8")));
    const missing = keys(template).filter(key => !have.has(key));
    if (missing.length) console.log(`env/${example.replace(/\.example$/, "")} has no ${missing.join(", ")} (see ${example})`);
  }
}
