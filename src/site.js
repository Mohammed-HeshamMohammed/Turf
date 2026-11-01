export const PRODUCTION_ORIGIN = "https://callerwhale.com";
export function resolveSiteOrigin(value = PRODUCTION_ORIGIN) {
  let url;
  try {
    url = new URL(value || PRODUCTION_ORIGIN);
  } catch {
    throw new Error("SITE_URL must be an absolute HTTP(S) origin.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "SITE_URL must be an HTTP(S) origin without credentials, path, query or fragment.",
    );
  }
  return url.origin;
}
export const site = {
  origin:
    typeof __SITE_ORIGIN__ === "string" ? __SITE_ORIGIN__ : PRODUCTION_ORIGIN,
  indexable:
    typeof __SITE_INDEXABLE__ === "boolean" ? __SITE_INDEXABLE__ : true,
  name: "Caller Whale",
  image: "/images/property-hero.webp",
  imageAlt:
    "Residential architecture in warm afternoon light — Caller Whale property outreach.",
};
