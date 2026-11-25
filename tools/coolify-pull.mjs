// Runs on the VPS (a systemd timer, every two minutes; docs/history/plans/coolify-image-swap.md, "Deploys from GitHub"). GitHub cannot
// reach Coolify through Cloudflare's bot protection, which stays on, so this pulls instead: it reads the deployments the Images
// workflow records after the owner approves the "production" environment (tools/coolify-deploy.mjs --record), checks each again,
// and applies it to Coolify on localhost. Reading a public repository's deployments needs no GitHub token. It remembers the last
// deployment it applied in a state file, so each one is applied once; one that keeps failing is given up after three tries.
//   node coolify-pull.mjs          apply what is new (COOLIFY_TOKEN; COOLIFY_URL defaults to http://localhost:8000)
//   node coolify-pull.mjs --init   remember the newest deployment without applying anything (run once when installing)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PULL_ENVIRONMENT, checkApps, deploy } from "./coolify-deploy.mjs";

export const REPO = "Mohammed-HeshamMohammed/Turf";
const IMAGES = "ghcr.io/mohammed-heshammohammed/";
const TRIES = 3;

/** The deployments still to apply, oldest first: recorded by the Images workflow (GitHub Actions), newer than the last applied. */
export function pending(deployments, state) {
  return deployments
    .filter(d => d.id > (state.lastId ?? 0) && d.environment === PULL_ENVIRONMENT && d.creator?.login === "github-actions[bot]")
    .sort((a, b) => a.id - b.id);
}

/** The plan in a deployment, checked: only this repository's images. */
export function appsOf(deployment) {
  const apps = checkApps(deployment.payload?.apps);
  for (const a of apps) {
    const names = a.image ? [a.image.name] : a.settings.map(s => s.value);
    if (names.some(n => !n.startsWith(IMAGES))) throw new Error(`${a.app}: an image from outside ${IMAGES}`);
  }
  return apps;
}

/** Applies every pending deployment in order; returns the new state. Each application is applied on its own and remembered, so one
 * that fails (not set up yet, say) never holds back the others in the same deployment: a retry repeats only the ones that failed. A
 * deployment with a failure stops the queue so the order is kept, and is given up after three tries. */
export async function pull({ deployments, state, base, token, log = console.log, apply = deploy }) {
  const next = { lastId: state.lastId ?? 0, tries: { ...(state.tries ?? {}) }, done: { ...(state.done ?? {}) } };
  for (const d of pending(deployments, next)) {
    let apps;
    try {
      apps = appsOf(d);
    } catch (error) {
      log(`deployment ${d.id}: refused, ${error.message}`);
      next.lastId = d.id;
      continue;
    }
    log(`deployment ${d.id} (${String(d.sha).slice(0, 7)}): ${apps.length} application(s)`);
    const done = new Set(next.done[d.id] ?? []);
    const failed = [];
    for (const app of apps.filter(a => !done.has(a.app))) {
      try {
        await apply([app], { base, token, log });
        done.add(app.app);
      } catch (error) {
        failed.push(app.app);
        log(`deployment ${d.id}: ${app.app} failed: ${error.message}`);
      }
    }
    next.done[d.id] = [...done];
    if (!failed.length) {
      next.lastId = d.id;
      delete next.tries[d.id];
      delete next.done[d.id];
      continue;
    }
    next.tries[d.id] = (next.tries[d.id] ?? 0) + 1;
    log(`deployment ${d.id}: ${failed.length} application(s) failed (try ${next.tries[d.id]} of ${TRIES})`);
    if (next.tries[d.id] < TRIES) break;
    log(`deployment ${d.id}: given up for ${failed.join(", ")}; the next one goes ahead`);
    next.lastId = d.id;
    delete next.tries[d.id];
    delete next.done[d.id];
  }
  return next;
}

async function deploymentsFromGitHub() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/deployments?environment=${PULL_ENVIRONMENT}&per_page=30`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "callerwhale-coolify-pull" },
  });
  if (res.status !== 200) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stateFile = process.env.STATE_FILE ?? "state.json";
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    /* first run */
  }
  const deployments = await deploymentsFromGitHub();
  if (process.argv.includes("--init")) {
    const lastId = Math.max(0, ...deployments.map(d => d.id));
    writeFileSync(stateFile, JSON.stringify({ lastId, tries: {} }) + "\n");
    console.log(`Remembered deployment ${lastId}; newer ones will be applied.`);
  } else {
    const token = process.env.COOLIFY_TOKEN ?? "";
    if (!token) {
      console.error("Set COOLIFY_TOKEN (a Coolify API token with write and deploy).");
      process.exit(1);
    }
    const base = (process.env.COOLIFY_URL ?? "http://localhost:8000").replace(/\/+$/, "");
    const next = await pull({ deployments, state, base, token });
    writeFileSync(stateFile, JSON.stringify(next) + "\n");
  }
}
