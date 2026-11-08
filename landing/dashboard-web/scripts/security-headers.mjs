// Writes the response headers the CRM web app is served with, as an nginx snippet, when the image is built. The content
// security policy names the other addresses the app may talk to (the auth service and the gateway), so they come from the
// same build settings the app is built with, and the build stops when one is missing or is not a safe address.
//
//   node security-headers.mjs <output file>      reads VITE_CALLERWHALE_AUTH_URL and VITE_CALLERWHALE_API_URL
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The origin (scheme and host) of a service address, or an error saying what is wrong with it. */
export function originOf(value, setting) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error(`Set ${setting} to a service origin, like https://auth.example.com`); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error(`${setting} must be an https address`);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    throw new Error(`${setting} must be only the address, with no path, query or login`);
  }
  return url.origin;
}

/** The headers, one `add_header` per line. Included again in every nginx location that sets a header of its own. */
export function securityHeaders(authUrl, apiUrl) {
  const auth = originOf(authUrl, "VITE_CALLERWHALE_AUTH_URL");
  const api = originOf(apiUrl, "VITE_CALLERWHALE_API_URL");
  const events = new URL(api);
  events.protocol = events.protocol === "https:" ? "wss:" : "ws:";
  const policy = [
    "default-src 'none'",
    // The human check, when the auth service turns it on, loads Google's script and frame. Cloudflare injects its analytics beacon at the edge.
    "script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/ https://static.cloudflareinsights.com",
    // The screens set styles on elements (style attributes); the human check adds one <style> that hides Google's badge.
    "style-src 'self' 'unsafe-inline'",
    // Map tiles, people's profile pictures and GIFs come from other hosts.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    `connect-src 'self' ${auth} ${api} ${events.origin} https://www.google.com/recaptcha/ https://api.giphy.com https://cloudflareinsights.com`,
    "frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/",
    "worker-src 'self' blob:",
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
    'add_header X-Robots-Tag "noindex, nofollow" always;',
    'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
    // Calls and live captions use the microphone; nothing else on the page may.
    'add_header Permissions-Policy "camera=(), microphone=(self), geolocation=(), payment=()" always;',
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file] = process.argv.slice(2);
  if (!file) throw new Error("Usage: node security-headers.mjs <output file>");
  writeFileSync(file, securityHeaders(process.env.VITE_CALLERWHALE_AUTH_URL, process.env.VITE_CALLERWHALE_API_URL));
}
