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

/** Applies every pending deployment in order; returns the new state. Stops at the first failure so the order is kept. */
export async function pull({ deployments, state, base, token, log = console.log, apply = deploy }) {
  const next = { lastId: state.lastId ?? 0, tries: { ...(state.tries ?? {}) } };
  for (const d of pending(deployments, next)) {
    try {
      const apps = appsOf(d);
      log(`deployment ${d.id} (${String(d.sha).slice(0, 7)}): ${apps.length} application(s)`);
      await apply(apps, { base, token, log });
      next.lastId = d.id;
      delete next.tries[d.id];
    } catch (error) {
      next.tries[d.id] = (next.tries[d.id] ?? 0) + 1;
      log(`deployment ${d.id} failed (try ${next.tries[d.id]} of ${TRIES}): ${error.message}`);
      if (next.tries[d.id] >= TRIES) {
        log(`deployment ${d.id}: given up; the next one goes ahead`);
        next.lastId = d.id;
        delete next.tries[d.id];
        continue;
      }
      break;
    }
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
