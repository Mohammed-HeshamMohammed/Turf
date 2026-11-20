// Step 48 (D379, D381): puts freshly built images into Coolify. The Images workflow's build job leaves one record per pushed image
// that has a Coolify target in tools/production.json ({image, ref, digest, coolify, setting}); the deploy job, after the
// "production" environment's approval, runs this. Two kinds of target:
//   - a Docker Image application ("deploy": {"coolify": "<id>"}): its image and tag are set to the image's digest;
//   - a Docker Compose application ("deploy": {"coolify": "<id>", "setting": "NAME"}): the setting NAME is set to <image>@<digest>,
//     which the compose file's image: line reads (the monitoring resource).
// Each application is then redeployed once.
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

/** Records grouped by Coolify application, checked and sorted:
 *  [{app, settings: [{key, value, image}]}] for a compose application, [{app, image: {name, tag, ref}}] for an image application. */
export function plan(records) {
  const apps = new Map();
  for (const r of records) {
    if (!r.coolify) continue;
    if (!/^[a-z0-9]{20,32}$/.test(r.coolify)) throw new Error(`${r.image}: not a Coolify application id: ${r.coolify}`);
    if (r.setting && !SETTING.test(r.setting)) throw new Error(`${r.image}: not a Coolify setting name: ${r.setting}`);
    if (!DIGEST.test(r.digest ?? "")) throw new Error(`${r.image}: not an image digest: ${r.digest}`);
    if (!/^ghcr\.io\/[a-z0-9-]+\/cw-[a-z0-9-]+$/.test(r.ref ?? "")) throw new Error(`${r.image}: unexpected image name ${r.ref}`);
    const app = apps.get(r.coolify) ?? { app: r.coolify };
    if (r.setting) {
      if (app.image) throw new Error(`${r.coolify}: is both an image application and a compose application`);
      app.settings ??= [];
      if (app.settings.some(s => s.key === r.setting)) throw new Error(`${r.coolify}: ${r.setting} is set by two images`);
      app.settings.push({ key: r.setting, value: `${r.ref}@${r.digest}`, image: r.image });
    } else {
      if (app.image || app.settings) throw new Error(`${r.coolify}: an image application runs one image (${r.image})`);
      // The image name plain and the tag "sha256-<hex>": Coolify then pulls <name>@sha256:<hex>. (Its own form stored the name as
      // "<name>@sha256", which made it pull "<name>@sha256@sha256:..." and fail; proved on the Learning app, 2026-11-20.)
      app.image = { name: r.ref, tag: r.digest.replace(":", "-"), ref: `${r.ref}@${r.digest}` };
    }
    apps.set(r.coolify, app);
  }
  return [...apps.values()]
    .sort((a, b) => a.app.localeCompare(b.app))
    .map(a => (a.settings ? { ...a, settings: a.settings.sort((x, y) => x.key.localeCompare(y.key)) } : a));
}

/**
 * The deploy secret (COOLIFY_DEPLOY_SECRET, the production environment's secret): the owner keeps Cloudflare's bot check on Coolify,
 * and its rule lets through to /api/ only a request carrying this exact value in x-callerwhale-deploy
 * (docs/plans/coolify-image-swap.md, "Deploys from GitHub"). Without it, no header is sent.
 */
export function deployHeaders(env = process.env) {
  const secret = env.COOLIFY_DEPLOY_SECRET ?? "";
  return secret ? { "x-callerwhale-deploy": secret } : {};
}

async function call(base, token, method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", ...deployHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // Cloudflare in front of Coolify: its bot check answers a script with a challenge page, so nothing reaches Coolify.
  if (res.status === 403 && /Just a moment|challenge-platform/i.test(text))
    throw new Error(`Cloudflare's bot check answered instead of Coolify (403 on ${method} ${path})${Object.keys(deployHeaders()).length ? "" : " and no deploy secret was sent (COOLIFY_DEPLOY_SECRET)"}: requests to ${base}/api/ with the secret must skip the check (docs/plans/coolify-image-swap.md, "Deploys from GitHub").`);
  return { status: res.status, text };
}

/** Sets each application's image (or settings), then queues one deploy per application. Stops at the first refusal. */
export async function deploy(apps, { base, token, log = console.log }) {
  for (const { app, settings, image } of apps) {
    if (image) {
      const r = await call(base, token, "PATCH", `/applications/${app}`, {
        docker_registry_image_name: image.name,
        docker_registry_image_tag: image.tag,
      });
      if (r.status >= 300) throw new Error(`${app}: setting the image failed (${r.status}) ${r.text.slice(0, 200)}`);
      log(`${app}: image ${image.ref}`);
    }
    for (const s of settings ?? []) {
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
