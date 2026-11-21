// Sets a Firebase project's sign-in rules for Caller Whale (docs/plans/firebase-auth.md, step 9): authenticator-app codes on,
// passwords of 12 characters or more, and sign-in that does not reveal which emails have accounts. Safe to run again.
//
//   node tools/firebase/configure-auth.mjs [project-id]
//
// The project and the service account's key come from env/firebase.env (FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT:
// the key's JSON itself, not the path of a key file). Needs the project upgraded to Identity Platform first; without
// it Firebase refuses the authenticator setting.

import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

try {
  process.loadEnvFile(new URL("../../env/firebase.env", import.meta.url));
} catch {
  /* No file: the environment must have the settings. */
}

/** The service account from FIREBASE_SERVICE_ACCOUNT. Its private key's "\n"s may have become line breaks on the way. */
function serviceAccount(text) {
  try {
    return JSON.parse(String(text || "").trim().replace(/\r?\n/g, "\\n"));
  } catch {
    return null;
  }
}

const projectId = process.argv[2] || process.env.FIREBASE_PROJECT_ID;
const account = serviceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!projectId || !account?.private_key) {
  console.error("Set FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT in env/firebase.env (see env/README.md and firebase.env.example).");
  process.exit(1);
}

initializeApp({ credential: cert(account), projectId });
const projects = getAuth().projectConfigManager();

await projects.updateProjectConfig({
  // Authenticator apps only. SMS codes stay off: they cost money per message and can be stolen by SIM swaps.
  // One 30-second step either side of now allows for a phone clock that is a little off.
  multiFactorConfig: { state: "ENABLED", providerConfigs: [{ state: "ENABLED", totpProviderConfig: { adjacentIntervals: 1 } }] },
  // The same rule as today's service: 12 characters or more. Older, shorter passwords must change at next sign-in.
  passwordPolicyConfig: { enforcementState: "ENFORCE", forceUpgradeOnSignin: true, constraints: { minLength: 12 } },
  // A wrong email and a wrong password get the same answer, so nobody can test which emails have accounts.
  emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
});

console.log(JSON.stringify((await projects.getProjectConfig()).toJSON(), null, 2));
