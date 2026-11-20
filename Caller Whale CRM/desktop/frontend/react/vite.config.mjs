import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { serviceBridge } from "./scripts/service-bridge.mjs";

// Settings from env/desktop.env (env/README.md); a variable already set wins. Vite hands the VITE_ ones to the app.
try {
  process.loadEnvFile(new URL("../../../env/desktop.env", import.meta.url));
} catch {
  /* No file: the app's own defaults (a local server, the auth service). */
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    // The desktop window loads these on demand (window controls, Skip Tracing, Google sign-in). Bundled up front so a
    // first click never meets a re-bundle and a stale module address.
    include: [
      "react",
      "react-dom/client",
      "@phosphor-icons/react",
      "recharts",
      "dexie",
      "papaparse",
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/api/window",
      "@tauri-apps/api/webviewWindow",
    ],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), serviceBridge()],
});
