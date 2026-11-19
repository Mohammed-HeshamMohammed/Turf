// Step 48 (D379, D381): puts freshly built images into Coolify. The Images workflow's build job leaves one record per pushed image
// that has a Coolify target in tools/production.json ({image, ref, digest, coolify, setting}); the deploy job, after the
// "production" environment's approval, runs this to write each image reference (by digest) into its Coolify setting and then
// redeploy each Coolify application once.
//   node tools/coolify-deploy.mjs --plan <records dir>   prints apps=[...] for the workflow (no network)
//   node tools/coolify-deploy.mjs <records dir>          needs COOLIFY_URL and COOLIFY_TOKEN (a token with write and deploy)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SETTING = /^[A-Z][A-Z0-9_]*$/;

export function readRecords(dir) {
  let files = [];
  try {
    files = readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map(f => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/** Records grouped by Coolify application: [{app, settings: [{key, value, image}]}], checked and sorted. */
export function plan(records) {
  const apps = new Map();
  for (const r of records) {
    if (!r.coolify) continue;
    if (!/^[a-z0-9]{20,32}$/.test(r.coolify)) throw new Error(`${r.image}: not a Coolify application id: ${r.coolify}`);
    if (!SETTING.test(r.setting ?? "")) throw new Error(`${r.image}: needs the Coolify setting its digest goes to`);
    if (!DIGEST.test(r.digest ?? "")) throw new Error(`${r.image}: not an image digest: ${r.digest}`);
    if (!/^ghcr\.io\/[a-z0-9-]+\/cw-[a-z0-9-]+$/.test(r.ref ?? "")) throw new Error(`${r.image}: unexpected image name ${r.ref}`);
    const settings = apps.get(r.coolify) ?? [];
    if (settings.some(s => s.key === r.setting)) throw new Error(`${r.coolify}: ${r.setting} is set by two images`);
    settings.push({ key: r.setting, value: `${r.ref}@${r.digest}`, image: r.image });
    apps.set(r.coolify, settings);
  }
  return [...apps]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([app, settings]) => ({ app, settings: settings.sort((a, b) => a.key.localeCompare(b.key)) }));
}

async function call(base, token, method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

/** Writes each setting (creating it when Coolify has none), then queues one deploy per application. Stops at the first refusal. */
export async function deploy(apps, { base, token, log = console.log }) {
  for (const { app, settings } of apps) {
    for (const s of settings) {
      const body = { key: s.key, value: s.value, is_preview: false, is_literal: true };
      let r = await call(base, token, "PATCH", `/applications/${app}/envs`, body);
      if (r.status === 404) r = await call(base, token, "POST", `/applications/${app}/envs`, body);
      if (r.status >= 300) throw new Error(`${app}: setting ${s.key} failed (${r.status}) ${r.text.slice(0, 200)}`);
      log(`${app}: ${s.key} = ${s.value}`);
    }
    const r = await call(base, token, "POST", `/deploy?uuid=${app}&force=false`);
    if (r.status >= 300) throw new Error(`${app}: deploy failed (${r.status}) ${r.text.slice(0, 200)}`);
    log(`${app}: deploy queued ${r.text.slice(0, 200)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const apps = plan(readRecords(args.find(a => a !== "--plan") ?? "deploys"));
  if (args.includes("--plan")) {
    console.log(`apps=${JSON.stringify(apps)}`);
  } else {
    const base = (process.env.COOLIFY_URL ?? "").replace(/\/+$/, "");
    const token = process.env.COOLIFY_TOKEN ?? "";
    if (!/^https:\/\//.test(base) || !token) {
      console.error("Set COOLIFY_URL (Actions variable) and COOLIFY_TOKEN (the production environment's secret).");
      process.exit(1);
    }
    await deploy(apps, { base, token });
  }
}
