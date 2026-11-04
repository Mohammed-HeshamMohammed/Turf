// Which pages are for whom, so a page never shows the wrong state (a sign-in form to someone already signed in, or an
// account page to nobody). `me` is undefined while the sign-in state is still being asked, null when nobody is signed in.
const SIGNED_OUT_ONLY = ["/signin", "/signup", "/forgot"];
const SIGNED_IN_ONLY = ["/account"];

export const cleanPath = path => path.replace(/(.)\/$/, "$1");

/** Where to send the visitor instead of showing this page, or null to stay. Nothing is decided while `me` is unknown. */
export function redirectFor(path, me) {
  if (me === undefined) return null;
  const page = cleanPath(path);
  if (me && SIGNED_OUT_ONLY.includes(page)) return "/account";
  if (!me && SIGNED_IN_ONLY.includes(page)) return "/signin";
  return null;
}
