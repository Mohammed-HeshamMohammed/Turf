// Build step 42 (D303): errors in this page are sent to the auth service's log with the error's kind, the page's path, where in the
// code and the version. The error's text is never sent: it can hold names, numbers or message text. The CRM web app has the same
// file (desktop/frontend/react/src/error-report.js).

type Report = { app: string; kind: string; page: string; where: string[]; version: string };

/** The code's places in a stack: script addresses with line and column, at most three. */
export function framesOf(stack: string | undefined): string[] {
  const found = (stack || "").match(/https?:\/\/[^\s()]+:\d+:\d+/g) || [];
  return found.slice(0, 3);
}

export function reportFor(error: unknown, pathname: string, app: string, version: string): Report {
  const e = error instanceof Error ? error : null;
  const kind = e && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e.name) ? e.name : "Error";
  return { app, kind, page: pathname, where: framesOf(e?.stack), version };
}

/** Sends at most ten reports a page, once for each kind and place. */
export function installErrorReports(endpoint: string, app: string, version: string) {
  if (typeof window === "undefined") return;
  const sent = new Set<string>();
  const send = (error: unknown) => {
    const report = reportFor(error, window.location.pathname, app, version);
    const key = `${report.kind}@${report.where[0] || ""}`;
    if (sent.has(key) || sent.size >= 10) return;
    sent.add(key);
    void fetch(endpoint, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) }).catch(() => undefined);
  };
  window.addEventListener("error", event => send(event.error));
  window.addEventListener("unhandledrejection", event => send(event.reason));
}
