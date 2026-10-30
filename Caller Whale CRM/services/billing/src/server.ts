// Billing service. Scaffold: it answers /healthz and /version. Node runs this TypeScript directly (type stripping), so there
// is no build step and no dependency until the first real one is needed.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

export const SERVICE = "billing";
export const VERSION = "0.1.0";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export function route(method: string, path: string): Reply {
  if (method === "GET" && path === "/healthz") return { status: 200, body: { ok: true, service: SERVICE } };
  if (method === "GET" && path === "/version") return { status: 200, body: { service: SERVICE, version: VERSION } };
  return { status: 404, body: { error: "Not found." } };
}

export function createApp(): Server {
  return createServer((req, res) => {
    const { status, body } = route(req.method ?? "GET", new URL(req.url ?? "/", "http://localhost").pathname);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8103);
  createApp().listen(port, () => console.log(`${SERVICE} listening on http://localhost:${port}`));
}
