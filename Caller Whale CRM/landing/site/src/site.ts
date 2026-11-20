export const PRODUCTION_ORIGIN = "https://callerwhale.com";

/** The site's own address, from SITE_URL when the pages are built. Anything but a plain http(s) origin stops the build. */
export function resolveSiteOrigin(value = PRODUCTION_ORIGIN) {
  let url;
  try {
    url = new URL(value || PRODUCTION_ORIGIN);
  } catch {
    throw new Error("SITE_URL must be an absolute HTTP(S) origin.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("SITE_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  return url.origin;
}

export const site = { name: "Caller Whale", origin: PRODUCTION_ORIGIN };
