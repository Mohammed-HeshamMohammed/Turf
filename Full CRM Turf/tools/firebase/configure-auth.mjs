// Sets a Firebase project's sign-in rules for Turf (docs/plans/firebase-auth.md, step 9): authenticator-app codes on,
// passwords of 12 characters or more, and sign-in that does not reveal which emails have accounts. Safe to run again.
//
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node configure-auth.mjs <project-id>
//
// Needs the project upgraded to Identity Platform first; without it Firebase refuses the authenticator setting.

import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const projectId = process.argv[2];
if (!projectId || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Usage: GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node configure-auth.mjs <project-id>");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId });
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
