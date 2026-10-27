// Bundles the website's Firebase sign-in (services/auth/clients/firebase-web-entry.js and the Firebase SDK) into
// services/core-api/website/firebase-auth.js. Run after changing the client or updating the SDK:
//   npm --prefix "Full CRM Turf/tools/firebase" install && node "Full CRM Turf/tools/firebase/build-website.mjs"
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
await build({
  entryPoints: [join(root, "services", "auth", "clients", "firebase-web-entry.js")],
  outfile: join(root, "services", "core-api", "website", "firebase-auth.js"),
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2020",
  // The entry lives outside this folder; Firebase is installed here.
  nodePaths: [join(here, "node_modules")],
  banner: { js: "// Built by tools/firebase/build-website.mjs from services/auth/clients/firebase-web-entry.js. Do not edit." },
  legalComments: "eof",
});
console.log("built services/core-api/website/firebase-auth.js");
