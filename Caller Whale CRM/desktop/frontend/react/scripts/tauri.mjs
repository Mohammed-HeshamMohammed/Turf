// Runs the Tauri CLI inside the desktop container (desktop/container/rust). The CLI looks for tauri.conf.json in the
// folder it is run from and below it, and the container is a sibling of this frontend, not a child, so npm scripts go
// through here:  node scripts/tauri.mjs dev   (any Tauri command and flags work)
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = join(dirname(fileURLToPath(import.meta.url)), "..");
const container = join(frontend, "..", "..", "container", "rust");
const cli = join(frontend, "node_modules", "@tauri-apps", "cli", "tauri.js");

export function runTauri(args, env = {}) {
  return spawn(process.execPath, [cli, ...args], { cwd: container, stdio: "inherit", env: { ...process.env, ...env } });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTauri(process.argv.slice(2)).on("exit", code => process.exit(code ?? 0));
}
