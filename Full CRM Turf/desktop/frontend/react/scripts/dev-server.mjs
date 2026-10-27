// Starts the Vite dev server for the desktop app on port 5190, or reuses it when it is already running
// (for instance from the browser preview), so `npm run desktop` works either way.
import { spawn } from "node:child_process";

const URL = "http://localhost:5190";
const up = await fetch(URL).then(
  () => true,
  () => false,
);
if (up) {
  console.log("Dev server already running at " + URL);
  setInterval(() => {}, 1 << 30); // Tauri expects this command to keep running.
} else {
  const child = spawn("npm", ["run", "dev", "--", "--port", "5190", "--strictPort"], { stdio: "inherit", shell: true });
  child.on("exit", code => process.exit(code ?? 0));
}
