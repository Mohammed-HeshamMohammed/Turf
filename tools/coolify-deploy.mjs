// Puts freshly built images into Coolify (D379, D381). The Images workflow's build job leaves one record per pushed image
// that has a Coolify target in tools/production.json ({image, ref, digest, coolify, setting}); the deploy job, after the
// "production" environment's approval, runs this. Two kinds of target:
//   - a Docker Image application ("deploy": {"coolify": "<id>"}): its image and tag are set to the image's digest;
//   - a Docker Compose application ("deploy": {"coolify": "<id>", "setting": "NAME"}): the setting NAME is set to <image>@<digest>,
//     which the compose file's image: line reads (the monitoring resource).
// Each application is then redeployed once.
// GitHub cannot reach Coolify: Cloudflare's bot protection (Bot Fight Mode, which the owner keeps on) stops scripts from datacenters.
// So after the approval the job only records the plan as a GitHub deployment (--record), and tools/coolify-pull.mjs on the server
// reads it and applies it to Coolify on localhost (docs/history/plans/coolify-image-swap.md, "Deploys from GitHub").
//   node tools/coolify-deploy.mjs --plan <records dir>     prints apps=[...] for the workflow (no network)
//   node tools/coolify-deploy.mjs --record <records dir>   creates the GitHub deployment (GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA)
//   node tools/coolify-deploy.mjs <records dir>            applies it now: COOLIFY_URL and COOLIFY_TOKEN (on the server only)
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

/** The GitHub deployment environment the server's puller reads (tools/coolify-pull.mjs). */
export const PULL_ENVIRONMENT = "coolify-pull";

/** A plan as it comes back from GitHub, checked again before anything touches Coolify; throws on anything unexpected. */
export function checkApps(apps) {
  if (!Array.isArray(apps) || apps.length === 0 || apps.length > 40) throw new Error("the plan is not a short list of applications");
  const ref = /^ghcr\.io\/[a-z0-9-]+\/cw-[a-z0-9-]+@sha256:[0-9a-f]{64}$/;
  for (const a of apps) {
    if (!/^[a-z0-9]{20,32}$/.test(a?.app ?? "")) throw new Error(`not a Coolify application id: ${a?.app}`);
    if (a.image) {
      const { name, tag } = a.image;
      if (!/^ghcr\.io\/[a-z0-9-]+\/cw-[a-z0-9-]+$/.test(name ?? "") || !/^sha256-[0-9a-f]{64}$/.test(tag ?? ""))
        throw new Error(`${a.app}: unexpected image ${name}:${tag}`);
      if (a.settings) throw new Error(`${a.app}: both an image and settings`);
    } else if (Array.isArray(a.settings) && a.settings.length) {
      for (const s of a.settings) if (!SETTING.test(s?.key ?? "") || !ref.test(s?.value ?? "")) throw new Error(`${a.app}: unexpected setting ${s?.key}`);
    } else throw new Error(`${a.app}: nothing to set`);
  }
  return apps;
}

/** Records the approved plan as a GitHub deployment for the server's puller to apply. */
export async function record(apps, { repo, sha, token, log = console.log }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/deployments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: sha, environment: PULL_ENVIRONMENT, auto_merge: false, required_contexts: [], payload: { apps: checkApps(apps) },
      description: `${apps.length} Coolify application(s), approved in GitHub`,
    }),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`recording the deployment failed (${res.status}) ${text.slice(0, 200)}`);
  const id = JSON.parse(text).id;
  for (const a of apps) log(`${a.app}: ${a.image ? a.image.ref : a.settings.map(s => `${s.key} = ${s.value}`).join(", ")}`);
  log(`Recorded as GitHub deployment ${id}; the server applies it within a few minutes (tools/coolify-pull.mjs).`);
  return id;
}

async function call(base, token, method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // Cloudflare in front of Coolify: its bot protection answers a script with a challenge page, so nothing reaches Coolify.
  if (res.status === 403 && /Just a moment|challenge-platform/i.test(text))
    throw new Error(`Cloudflare's bot protection answered instead of Coolify (403 on ${method} ${path}): call Coolify on the server itself (localhost), as tools/coolify-pull.mjs does.`);
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
  const apps = plan(readRecords(args.find(a => !a.startsWith("--")) ?? "deploys"));
  if (args.includes("--plan")) {
    console.log(`apps=${JSON.stringify(apps)}`);
  } else if (args.includes("--record")) {
    const { GITHUB_TOKEN: token = "", GITHUB_REPOSITORY: repo = "", GITHUB_SHA: sha = "" } = process.env;
    if (!token || !repo || !sha) {
      console.error("Set GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA (GitHub Actions sets the last two).");
      process.exit(1);
    }
    await record(apps, { repo, sha, token });
  } else {
    const base = (process.env.COOLIFY_URL ?? "").replace(/\/+$/, "");
    const token = process.env.COOLIFY_TOKEN ?? "";
    if (!/^https?:\/\//.test(base) || !token) {
      console.error("Set COOLIFY_URL (like http://localhost:8000 on the server) and COOLIFY_TOKEN.");
      process.exit(1);
    }
    await deploy(apps, { base, token });
  }
}
