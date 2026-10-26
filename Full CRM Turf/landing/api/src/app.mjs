import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { checkContact, checkWaitlist } from "./validate.mjs";

const MAX_BODY = 16 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff",
};

/** A page path the site really has: lowercase words and dashes, so the counter cannot be filled with junk. */
const PAGE_PATH = /^\/(?:[a-z][a-z-]{0,30})?$/;

/** A fixed-window limiter: `limit` requests per `windowMs` for one key (an address). */
function limiter(limit, windowMs, now) {
  const hits = new Map();
  return key => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Message too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("Send JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The landing API as an HTTP server. `origins` are the sites allowed to call it from a browser (the landing site is
 * normally on the same origin, so this only matters in development).
 */
export function createApp({ store, release, origins = [], webDir = "", statsToken = "", now = Date.now }) {
  const allowWrite = limiter(8, 60_000, now);
  const allowHit = limiter(120, 60_000, now);

  /** Files of the built site. A path with no file extension is a page: its prerendered folder, or the 404 page. */
  async function serveStatic(req, res, pathname) {
    if (!webDir || (req.method !== "GET" && req.method !== "HEAD")) return false;
    let rel;
    try {
      rel = normalize(decodeURIComponent(pathname));
    } catch {
      return false;
    }
    if (rel.includes("\0") || rel.split(sep).includes("..")) return false;
    const isPage = extname(rel) === "";
    const file = isPage ? join(webDir, rel, "index.html") : join(webDir, rel);
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] || "application/octet-stream",
        "cache-control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    } catch {
      /* not a file of the site */
    }
    if (isPage) {
      try {
        const body = await readFile(join(webDir, "404.html"));
        res.writeHead(404, { "content-type": TYPES[".html"], "cache-control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : body);
        return true;
      } catch {
        /* no 404 page built */
      }
    }
    return false;
  }

  const send = (res, status, body, req) => {
    const origin = req?.headers.origin;
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(origin && origins.includes(origin) ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
    });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "OPTIONS") {
        const allowed = origins.includes(req.headers.origin);
        res.writeHead(204, {
          ...(allowed ? { "access-control-allow-origin": req.headers.origin, vary: "origin" } : {}),
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true }, req);
      if (req.method === "GET" && url.pathname === "/api/download") return send(res, 200, await release(), req);

      if (req.method === "POST" && (url.pathname === "/api/waitlist" || url.pathname === "/api/contact")) {
        if (!allowWrite(req.socket.remoteAddress || "unknown")) {
          return send(res, 429, { error: "Too many requests. Try again in a minute." }, req);
        }
        const body = await readJson(req);
        if (body?.website) return send(res, 200, { ok: true }, req); // a hidden field only bots fill in
        if (url.pathname === "/api/waitlist") {
          const { value, error } = checkWaitlist(body);
          if (error) return send(res, 400, { error }, req);
          return send(res, 200, { ok: true, joined: store.joinWaitlist(value) }, req);
        }
        const { value, error } = checkContact(body);
        if (error) return send(res, 400, { error }, req);
        store.saveMessage(value);
        return send(res, 200, { ok: true }, req);
      }
      if (req.method === "POST" && url.pathname === "/api/hit") {
        // Page views without cookies, addresses or user agents: only a day, a page and a count are kept.
        if (!allowHit(req.socket.remoteAddress || "unknown")) return send(res, 429, { error: "Slow down." }, req);
        const body = await readJson(req);
        if (typeof body?.path === "string" && PAGE_PATH.test(body.path)) store.recordHit(body.path);
        res.writeHead(204, { "cache-control": "no-store" });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/api/stats") {
        if (!statsToken || req.headers.authorization !== `Bearer ${statsToken}`) return send(res, 401, { error: "Not allowed." }, req);
        return send(res, 200, { waitlist: store.waitlistCount(), hits: store.hitSummary(30) }, req);
      }
      if (!url.pathname.startsWith("/api/") && (await serveStatic(req, res, url.pathname))) return;
      return send(res, 404, { error: "Not found." }, req);
    } catch (e) {
      const status = e.status || 500;
      return send(res, status, { error: status === 500 ? "Something went wrong." : e.message }, req);
    }
  });
}
