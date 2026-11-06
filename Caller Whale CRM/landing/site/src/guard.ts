import type { Me } from "./auth/auth-client.js";
import { cleanPath } from "./routes.ts";

// Which pages are for whom, so a page never shows the wrong state (a sign-in form to someone already signed in, or an
// account page to nobody). `me` is undefined while the sign-in state is still being asked, null when nobody is signed in.
const SIGNED_OUT_ONLY = ["/signin", "/signup", "/forgot"];
const SIGNED_IN_ONLY = ["/account", "/dashboard", "/connect"];

/** True when this person set up a second step and this sign-in has not passed it yet (after Google, or a session older than it). */
export function waitingForSecondStep(me: Me): boolean {
  return me.mfa_enrolled === true && me.mfa_passed === false;
}

/** Where to send the visitor instead of showing this page, or null to stay. Nothing is decided while `me` is unknown. */
export function redirectFor(path: string, me: Me | null | undefined): string | null {
  if (me === undefined) return null;
  const page = cleanPath(path);
  // Signed in but the second step is not done: the person stays on (or goes back to) /signin, where the sign-in card is
  // replaced by the "confirm it's you" card. Nothing behind the sign-in opens before it.
  if (me && waitingForSecondStep(me)) return page === "/signin" ? null : SIGNED_IN_ONLY.includes(page) || SIGNED_OUT_ONLY.includes(page) ? "/signin" : null;
  if (me && SIGNED_OUT_ONLY.includes(page)) return "/dashboard";
  if (!me && SIGNED_IN_ONLY.includes(page)) return "/signin";
  return null;
}
