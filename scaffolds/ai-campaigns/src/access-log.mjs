/** Log only method, path, completion status and elapsed time. Never headers or bodies. */
export function observeRequest(req, res, log = line => console.info(line)) {
  const started = process.hrtime.bigint();
  const path = (req.url || "/").split(/[?#]/, 1)[0];
  const labels = { "/contact": "Contact form", "/waitlist": "Waitlist signup", "/version": "Service version" };
  res.once("finish", () => {
    if (path === "/healthz" && res.statusCode < 400) return;
    log(JSON.stringify({ cw_event: "request", event: labels[path] || "HTTP request", method: req.method, path,
      status: res.statusCode, duration_seconds: Number(process.hrtime.bigint() - started) / 1e9 }));
  });
  res.once("close", () => {
    if (!res.writableFinished) log(JSON.stringify({ level: "WARN", message: "Client disconnected before response completed", method: req.method, path }));
  });
}
