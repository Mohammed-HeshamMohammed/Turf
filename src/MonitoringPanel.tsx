import { useEffect, useRef, useState } from "react";
import type { Auth } from "./auth/auth-client.js";
import { SecondStep } from "./SecondStep.tsx";

const gateway = new URL(import.meta.env.VITE_CALLERWHALE_GATEWAY_URL || "https://gate.callerwhale.com").origin;
const monitoringPath = "/staff/monitoring/";

export function MonitoringPanel({ auth }: { auth: Auth }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"opening" | "ready" | "error" | "code">("opening");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const enter = async () => {
      setStatus("opening");
      try {
        const token = await auth.accessToken();
        if (!active || !token) throw new Error("Sign in again to continue.");
        const form = document.createElement("form");
        form.method = "POST";
        form.action = `${gateway}${monitoringPath}_callerwhale/session`;
        form.target = "callerwhale-monitoring";
        form.hidden = true;
        const input = document.createElement("input");
        input.name = "token";
        input.value = token;
        form.append(input);
        document.body.append(form);
        form.submit();
        form.remove();
      } catch {
        if (active) setStatus("error");
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin === gateway && event.source === frame.current?.contentWindow && event.data === "callerwhale-grafana-signin") {
        void enter();
      }
      if (event.origin === gateway && event.source === frame.current?.contentWindow && event.data === "callerwhale-grafana-stepup") {
        setStatus("code");  // Admin mode needs a code entered a moment ago: ask for it here, then open it again.
      }
    };
    addEventListener("message", onMessage);
    void enter();
    return () => {
      active = false;
      removeEventListener("message", onMessage);
    };
  }, [auth, attempt]);

  return <section className="admin-monitoring card" aria-labelledby="monitoring-title">
    <div className="admin-section-heading"><div><span className="eyebrow">Private monitoring</span><h2 id="monitoring-title">Grafana</h2><p className="muted">Platform owners, cofounders, and system administrators can view monitoring after the authenticator step.</p></div></div>
    {status === "error" && <div role="alert"><p>Monitoring could not open. Sign in again, then try once more.</p><button type="button" className="button raised" onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
    {status === "opening" && <p role="status">Opening private monitoring…</p>}
    {status === "code" && <SecondStep auth={auth} reason="Admin mode needs a code entered just now." onDone={() => setAttempt(count => count + 1)} />}
    <iframe ref={frame} name="callerwhale-monitoring" title="Grafana monitoring" hidden={status === "code"} onLoad={() => setStatus(current => current === "code" ? current : "ready")} />
  </section>;
}
