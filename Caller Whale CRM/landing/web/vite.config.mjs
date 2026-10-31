import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the landing API (landing/api, port 8095) is reached through the same origin; in production it has its own
// address (VITE_CALLERWHALE_LANDING_API_URL).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/waitlist": "http://localhost:8095", "/contact": "http://localhost:8095" } },
  preview: { proxy: { "/waitlist": "http://localhost:8095", "/contact": "http://localhost:8095" } },
});
