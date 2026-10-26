import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";
import { latestRelease } from "./release.mjs";
import { openStore } from "./store.mjs";

const port = Number(process.env.PORT || 8095);
const store = openStore(process.env.TURF_LANDING_DB || "data/landing.db");
const release = latestRelease({ repo: process.env.TURF_RELEASE_REPO });
const origins = (process.env.TURF_LANDING_ORIGINS || "http://localhost:5200").split(",").filter(Boolean);

// The built site (landing/web/dist) is served by this same process, so one service runs the whole landing site.
const webDir = process.env.TURF_LANDING_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const statsToken = process.env.TURF_LANDING_STATS_TOKEN || "";

createApp({ store, release, origins, webDir, statsToken }).listen(port, () => {
  console.log(`Turf landing API on http://localhost:${port}`);
});
