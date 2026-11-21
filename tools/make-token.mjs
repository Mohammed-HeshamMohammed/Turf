// Makes a caller token for one service to use when it calls another (BILLING_TOKENS, AUTHZ_TOKENS, NOTIFY_TOKENS and the
// matching *_TOKEN on the caller). 48 random bytes from the system's secure generator, written as 64 URL-safe characters: well
// above the 32-character minimum every service checks.
//
//   node tools/make-token.mjs            one token
//   node tools/make-token.mjs auth       the pair to paste: "auth=<token>" for the service called, and the bare token for the caller
//
// The token is printed once and not saved anywhere. Paste it into Coolify's environment variables only (never into a file in
// this repository). How to replace one without downtime: docs/operations/rotating-service-tokens.md.
import { randomBytes } from "node:crypto";

const token = randomBytes(48).toString("base64url");
const caller = process.argv[2];
if (caller && !/^[a-z][a-z0-9-]{0,39}$/.test(caller)) {
  console.error("The caller's name is lower-case letters, digits and dashes, like auth or core-api.");
  process.exit(1);
}
if (caller) {
  console.log(`For the service being called (its *_TOKENS list): ${caller}=${token}`);
  console.log(`For ${caller} itself (its *_TOKEN variable):        ${token}`);
} else {
  console.log(token);
}
