import { useEffect, useRef, useState } from "react";

let loading;
function turnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Human verification did not load. Reload and try again."));
    script.onerror = () => { loading = null; script.remove(); reject(new Error("Human verification could not load. Check your connection and try again.")); };
    document.head.append(script);
  });
  return loading;
}

/** The widget loads only when auth has bot protection enabled. Auth verifies every token itself. */
export function HumanCheck({ getAuth, action, resetKey = 0, onToken }) {
  const host = useRef(null);
  const callbacks = useRef({ getAuth, onToken });
  callbacks.current = { getAuth, onToken };
  const [status, setStatus] = useState({ enabled: false, error: "", loading: true });
  useEffect(() => {
    let live = true, widget, api;
    callbacks.current.onToken("");
    setStatus({ enabled: false, error: "", loading: true });
    (async () => {
      const auth = await callbacks.current.getAuth();
      const config = await auth.security();
      if (!live) return;
      if (!config.bot_protection?.enabled) return setStatus({ enabled: false, error: "", loading: false });
      setStatus({ enabled: true, error: "", loading: true });
      api = await turnstile();
      if (!live) return;
      widget = api.render(host.current, {
        sitekey: config.bot_protection.site_key, action, theme: "auto", size: "flexible",
        callback: token => live && callbacks.current.onToken(token),
        "expired-callback": () => live && callbacks.current.onToken(""),
        "error-callback": () => {
          if (live) { callbacks.current.onToken(""); setStatus({ enabled: true, error: "Human verification did not finish. Reload and try again.", loading: false }); }
        },
      });
      setStatus({ enabled: true, error: "", loading: false });
    })().catch(error => live && setStatus({ enabled: true, error: error.message, loading: false }));
    return () => { live = false; if (widget !== undefined && api) api.remove(widget); };
  }, [action, resetKey]);
  return <div className="human-check" hidden={!status.enabled && !status.loading}>
    {status.enabled && <p>Verify you’re human</p>}
    <div ref={host} />
    {status.loading && <p role="status">Checking sign-in protection…</p>}
    {status.error && <p role="alert">{status.error}</p>}
  </div>;
}
