import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Auth } from "./auth/auth-client.js";

const gateway = new URL(import.meta.env.VITE_CALLERWHALE_GATEWAY_URL || "https://gate.callerwhale.com").origin;
const monitoringPath = "/staff/monitoring/";

export function MonitoringPanel({ auth }: { auth: Auth }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"opening" | "ready" | "error" | "code">("opening");
  const [attempt, setAttempt] = useState(0);
  const [challenge, setChallenge] = useState<{ id: string; method: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  // Admin mode needs a code entered a moment ago. When the proxy says the last one is too old, ask for a new one here, in place of
  // the frame, and open admin mode again as soon as it is accepted.
  const askForCode = async () => {
    setStatus("code"); setMessage(""); setCode("");
    try {
      const started = (await auth.startStepUp()) as { challenge: string; methods: string[] };
      const method = started.methods.includes("totp") ? "totp" : started.methods.find(m => m === "email" || m === "telegram");
      if (!method) { setMessage("This account needs a second step this page cannot do yet. Use the Caller Whale app."); return; }
      if (method !== "totp") await auth.sendCode(started.challenge, method);
      setChallenge({ id: started.challenge, method });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start the check. Try again.");
    }
  };
  const submitCode = async (value: string) => {
    if (!challenge || busy) return;
    setBusy(true); setMessage("");
    try {
      await auth.answer(challenge.id, challenge.method, value);
      setChallenge(null); setCode("");
      setAttempt(count => count + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That code did not work.");
      setCode("");
    }
    setBusy(false);
  };

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
        void askForCode();
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
    {status === "code" && <form className="staff-code-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void submitCode(code.trim()); }}>
      <h3>Confirm it's you</h3>
      <p className="muted">{challenge && challenge.method !== "totp" ? `Enter the code we sent you by ${challenge.method} to open monitoring.` : "Enter the 6-digit code from your authenticator app to open monitoring."}</p>
      <div className="staff-code-row"><input inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={6} placeholder="000000" aria-label="Six-digit code" value={code} disabled={!challenge || busy}
        onChange={event => { const value = event.target.value.replace(/\D/g, "").slice(0, 6); setCode(value); if (value.length === 6) void submitCode(value); }} /><button className="button primary" disabled={!challenge || busy}>{busy ? "Checking…" : "Verify"}</button></div>
      {message && <p className="notice bad" role="alert">{message}</p>}
    </form>}
    <iframe ref={frame} name="callerwhale-monitoring" title="Grafana monitoring" hidden={status === "code"} onLoad={() => setStatus(current => current === "code" ? current : "ready")} />
  </section>;
}
