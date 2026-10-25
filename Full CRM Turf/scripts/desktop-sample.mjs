// Runs the desktop app on the sample workspace, with no Turf server: VITE_TURF_SAMPLE lifts the sign-in gate.
import { spawn } from "node:child_process";

spawn("npx", ["tauri", "dev"], { stdio: "inherit", shell: true, env: { ...process.env, VITE_TURF_SAMPLE: "true" } }).on("exit", code => process.exit(code ?? 0));
