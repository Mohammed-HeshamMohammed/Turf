// Runs the desktop app on the sample workspace, with no Caller Whale server: VITE_CALLERWHALE_SAMPLE lifts the sign-in gate.
import { runTauri } from "./tauri.mjs";

runTauri(["dev"], { VITE_CALLERWHALE_SAMPLE: "true" }).on("exit", code => process.exit(code ?? 0));
