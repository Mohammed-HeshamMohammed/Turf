import { createApp } from "./app.mjs";
import { latestRelease } from "./release.mjs";
import { openStore } from "./store.mjs";

const port = Number(process.env.PORT || 8095);
const store = openStore(process.env.CALLERWHALE_LANDING_DB || "data/landing.db");
const release = latestRelease({ repo: process.env.CALLERWHALE_RELEASE_REPO });
const origins = (process.env.CALLERWHALE_LANDING_ORIGINS || "http://localhost:5200").split(",").filter(Boolean);

createApp({ store, release, origins }).listen(port, () => {
  console.log(`Caller Whale landing API on http://localhost:${port}`);
});
