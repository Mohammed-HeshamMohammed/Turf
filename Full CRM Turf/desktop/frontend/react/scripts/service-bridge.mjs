// Development only: serves /rpc by talking to Caller Whale's Skip Tracing service (service/ at the repository root, Python) over JSON lines on
// stdin/stdout, one request at a time, like Caller Whale's own vite.config.ts. The desktop window uses the Tauri host instead.
//
// This dev server listens on every interface (vite.config.mjs), so the bridge is stricter than Caller Whale's: only requests
// from this computer, from the page's own origin, as JSON, and only the commands the Skip Tracing page sends.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const ALLOWED_COMMANDS = new Set([
  "health.check",
  "project.open_workspace",
  "dataset.import_content",
  "job.get",
  "job.cancel",
  "skiptrace.suggest",
  "skiptrace.statuses",
  "skiptrace.save_settings",
  "skiptrace.scan",
  "skiptrace.review",
  "skiptrace.apply",
  "skiptrace.repeats",
  "geo.zip_centres",
  "geo.locate",
  "geo.located",
  "skiptrace.model_status",
]);

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Why a request is refused, or null when it may reach the service. Exported for tests. */
export function refusal({ method, remoteAddress, origin, host, contentType }) {
  if (method !== "POST") return "Only POST is accepted";
  if (!LOOPBACK.has(remoteAddress)) return "Only this computer may use the Skip Tracing engine";
  const own = !origin || origin === `http://${host}` || origin === "tauri://localhost" || origin === "http://tauri.localhost";
  if (!own) return "Only Caller Whale's own page may use the Skip Tracing engine";
  if (!(contentType ?? "").startsWith("application/json")) return "Requests must be JSON";
  return null;
}

export function serviceBridge() {
  return {
    name: "turf-crm-service-bridge",
    apply: "serve",
    configureServer(server) {
      const root = resolve(process.env.CALLERWHALE_SERVICE_ROOT ?? "../../../../service");
      let child = null;
      let answers = null;
      let nextId = 0;
      let queue = Promise.resolve();

      function start() {
        if (!existsSync(join(root, "turf_service"))) throw new Error(`Caller Whale's Skip Tracing service was not found at ${root}.`);
        const started = spawn(process.env.CALLERWHALE_PYTHON ?? "python", ["-m", "turf_service.server", "--resources", root], {
          cwd: root,
          env: { ...process.env, PYTHONUTF8: "1", PYTHONPATH: root },
        });
        started.stderr.pipe(process.stderr);
        started.on("error", () => (child = null));
        started.on("exit", () => {
          if (child === started) child = null;
        });
        child = started;
        answers = createInterface({ input: started.stdout })[Symbol.asyncIterator]();
      }

      async function roundtrip(body) {
        const { command, payload } = JSON.parse(body);
        if (!ALLOWED_COMMANDS.has(command))
          return JSON.stringify({ schema_version: 1, ok: false, error: { code: "forbidden", message: "That command is not available to the CRM" } });
        if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload)))
          return JSON.stringify({ schema_version: 1, ok: false, error: { code: "invalid_request", message: "Payload must be an object" } });
        if (!child) start();
        const id = ++nextId;
        child.stdin.write(`${JSON.stringify({ id, schema_version: 1, command, payload: payload ?? {} })}\n`);
        const line = await answers.next();
        if (line.done) throw new Error("The Skip Tracing engine stopped. Is Python 3.11+ installed with service/requirements.txt, or CALLERWHALE_PYTHON set?");
        if (JSON.parse(line.value).id !== id) throw new Error("Service response did not match the request");
        return line.value;
      }

      server.middlewares.use("/rpc", (incoming, outgoing) => {
        const refused = refusal({
          method: incoming.method,
          remoteAddress: incoming.socket.remoteAddress,
          origin: incoming.headers.origin,
          host: incoming.headers.host,
          contentType: incoming.headers["content-type"],
        });
        if (refused) {
          incoming.resume();
          outgoing
            .writeHead(403, { "Content-Type": "application/json" })
            .end(JSON.stringify({ schema_version: 1, ok: false, error: { code: "forbidden", message: refused } }));
          return;
        }
        const chunks = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("end", () => {
          const turn = queue.then(() => roundtrip(Buffer.concat(chunks).toString("utf8")));
          queue = turn.catch(() => undefined);
          turn.then(
            line => outgoing.writeHead(200, { "Content-Type": "application/json" }).end(line),
            error => {
              child?.kill();
              child = null;
              outgoing
                .writeHead(200, { "Content-Type": "application/json" })
                .end(JSON.stringify({ schema_version: 1, ok: false, error: { code: "bridge_unavailable", message: String(error?.message ?? error) } }));
            },
          );
        });
      });

      server.httpServer?.once("close", () => child?.kill());
      process.once("exit", () => child?.kill());
    },
  };
}
