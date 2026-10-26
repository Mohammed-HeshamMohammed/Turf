import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { serviceBridge } from "./scripts/service-bridge.mjs";

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
    watch: { ignored: ["**/desktop/container/**"] },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), serviceBridge()],
});
