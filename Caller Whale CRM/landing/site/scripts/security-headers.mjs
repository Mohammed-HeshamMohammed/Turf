// Writes the response headers the site is served with, as an nginx snippet, when the image is built. The content security
// policy names the one other address the page may talk to (the auth service), so it comes from the same build setting the
// page is built with, and the build stops when that setting is missing or is not a safe address.
//
//   node scripts/security-headers.mjs <output file>      reads VITE_CALLERWHALE_AUTH_URL
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The one inline <style> the page makes (src/auth/human-check.jsx hides Google's badge), allowed by its hash and nothing else inline.
export const BADGE_STYLE = ".grecaptcha-badge{visibility:hidden}";
const badgeHash = `'sha256-${createHash("sha256").update(BADGE_STYLE).digest("base64")}'`;

/** The origin (scheme and host) of the auth service address, or an error saying what is wrong with it. */
export function authOrigin(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Set VITE_CALLERWHALE_AUTH_URL to the auth service's address, like https://auth.example.com");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("VITE_CALLERWHALE_AUTH_URL must be an https address");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    throw new Error("VITE_CALLERWHALE_AUTH_URL must be only the address, with no path, query or login");
  }
  return url.origin;
}

/** The headers, one `add_header` per line. Included again in every nginx location that sets a header of its own. */
export function securityHeaders(authUrl) {
  const origin = authOrigin(authUrl);
  const policy = [
    "default-src 'none'",
    // The invisible human check, when the auth service turns it on, loads Google's script and frame.
    "script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/",
    `style-src 'self' ${badgeHash}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${origin}`,
    "frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return [
    `add_header Content-Security-Policy "${policy}" always;`,
    'add_header Strict-Transport-Security "max-age=31536000" always;',
    'add_header X-Content-Type-Options "nosniff" always;',
    'add_header X-Frame-Options "DENY" always;',
    'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
    'add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;',
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error("Usage: node scripts/security-headers.mjs <output file>");
  writeFileSync(file, securityHeaders(process.env.VITE_CALLERWHALE_AUTH_URL));
}
