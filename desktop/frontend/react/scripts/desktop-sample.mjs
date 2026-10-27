// Runs the desktop app on the sample workspace, with no Turf server: VITE_TURF_SAMPLE lifts the sign-in gate.
import { runTauri } from "./tauri.mjs";

runTauri(["dev"], { VITE_TURF_SAMPLE: "true" }).on("exit", code => process.exit(code ?? 0));
