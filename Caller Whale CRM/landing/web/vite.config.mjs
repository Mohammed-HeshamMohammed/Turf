import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the landing API (landing/api, port 8095) is reached through the same origin.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8095" } },
  preview: { proxy: { "/api": "http://localhost:8095" } },
});
