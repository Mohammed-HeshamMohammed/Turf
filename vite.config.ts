import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Browser-only development: serves `/rpc` by talking to Turf's application service (service/) over JSON lines on
 * stdin/stdout, one request at a time. That is the same bridge the Rust host uses (src-tauri/src/sidecar.rs),
 * so a browser tab and the desktop window behave alike. The desktop window does not use this.
 */
function serviceBridge(): Plugin {
  return {
    name: "turf-service-bridge",
    apply: "serve",
    configureServer(server) {
      if (process.env.TAURI_ENV_PLATFORM) return;
      const root = resolve(process.env.TURF_SERVICE_ROOT ?? "service");
      let child: ChildProcessWithoutNullStreams | null = null;
      let answers: AsyncIterator<string> | null = null;
      let nextId = 0;
      let queue: Promise<unknown> = Promise.resolve();

      function start() {
        if (!existsSync(join(root, "turf_service"))) throw new Error(`Turf's service was not found at ${root}.`);
        const started = spawn(process.env.TURF_PYTHON ?? "python", ["-m", "turf_service.server", "--resources", root], {
          cwd: root,
          env: {
            ...process.env,
            PYTHONUTF8: "1",
            PYTHONPATH: root,
          },
        });
        started.stderr.pipe(process.stderr);
        started.on("error", () => {
          child = null;
        });
        started.on("exit", () => {
          if (child === started) child = null;
        });
        child = started;
        answers = createInterface({ input: started.stdout })[Symbol.asyncIterator]();
      }

      async function roundtrip(body: string) {
        const { command, payload } = JSON.parse(body) as { command: string; payload?: unknown };
        if (!child) start();
        const id = ++nextId;
        child!.stdin.write(`${JSON.stringify({ id, schema_version: 1, command, payload: payload ?? {} })}\n`);
        const line = await answers!.next();
        if (line.done) throw new Error("Turf's service stopped unexpectedly. Is Python 3.11+ installed with service/requirements.txt, or TURF_PYTHON set?");
        const answer = JSON.parse(line.value) as { id?: number };
        if (answer.id !== id) throw new Error("Service response did not match the request");
        return line.value;
      }

      server.middlewares.use("/rpc", (incoming, outgoing) => {
        const chunks: Buffer[] = [];
        incoming.on("data", chunk => chunks.push(chunk as Buffer));
        incoming.on("end", () => {
          const turn = queue.then(() => roundtrip(Buffer.concat(chunks).toString("utf8")));
          queue = turn.catch(() => undefined);
          turn.then(
            line => outgoing.writeHead(200, { "Content-Type": "application/json" }).end(line),
            error => {
              // A broken process is dropped; the next request starts a new one.
              child?.kill();
              child = null;
              const message = error instanceof Error ? error.message : String(error);
              outgoing
                .writeHead(200, { "Content-Type": "application/json" })
                .end(JSON.stringify({ schema_version: 1, ok: false, error: { code: "bridge_unavailable", message } }));
            },
          );
        });
      });

      server.httpServer?.once("close", () => child?.kill());
      process.once("exit", () => child?.kill());
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceBridge()],
  server: {
    // The desktop window loads this exact address, so the port must not move.
    port: 5183,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/service/**"] },
  },
  clearScreen: false,
});
