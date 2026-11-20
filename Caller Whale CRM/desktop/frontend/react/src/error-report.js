// Build step 42 (D303): errors in the CRM web app are sent to the auth service's log with the error's kind, the page's path, where in
// the code and the version. The error's text is never sent: it can hold names, numbers or message text. The website has the same
// file (landing/site/src/error-report.ts).

/** The code's places in a stack: script addresses with line and column, at most three. */
export function framesOf(stack) {
  const found = String(stack || "").match(/https?:\/\/[^\s()]+:\d+:\d+/g) || [];
  return found.slice(0, 3);
}

export function reportFor(error, pathname, app, version) {
  const kind = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : "Error";
  return { app, kind, page: pathname, where: framesOf(error instanceof Error ? error.stack : ""), version };
}

/** Sends at most ten reports a page, once for each kind and place. */
export function installErrorReports(endpoint, app, version) {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  const sent = new Set();
  const send = error => {
    const report = reportFor(error, window.location.pathname, app, version);
    const key = `${report.kind}@${report.where[0] || ""}`;
    if (sent.has(key) || sent.size >= 10) return;
    sent.add(key);
    fetch(endpoint, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) }).catch(() => undefined);
  };
  window.addEventListener("error", event => send(event.error));
  window.addEventListener("unhandledrejection", event => send(event.reason));
}
