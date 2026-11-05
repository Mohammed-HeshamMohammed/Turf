import { useEffect, useRef, useState } from "react";

let loading, loadedKey;
function recaptcha(siteKey) {
  if (window.grecaptcha?.execute && loadedKey === siteKey) return Promise.resolve(window.grecaptcha);
  if (!loading) {
    loadedKey = siteKey;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
      script.async = true;
      script.onload = () => window.grecaptcha ? window.grecaptcha.ready(() => resolve(window.grecaptcha)) : reject(new Error("The sign-in protection did not load. Reload and try again."));
      script.onerror = () => { loading = null; script.remove(); reject(new Error("The sign-in protection could not load. Check your connection and try again.")); };
      document.head.append(script);
    });
  }
  return loading;
}

// A reCAPTCHA token is good for two minutes; ask for a new one a little before that.
const REFRESH_MS = 90_000;

/**
 * Invisible: nobody ticks anything. Google scores the visit and auth refuses a low score, so a person acting like a person
 * never sees a challenge. Loads only when auth has bot protection enabled; auth verifies every token itself.
 */
export function HumanCheck({ getAuth, action, resetKey = 0, onToken }) {
  const callbacks = useRef({ getAuth, onToken });
  callbacks.current = { getAuth, onToken };
  const [status, setStatus] = useState({ enabled: false, error: "" });
  useEffect(() => {
    let live = true, timer;
    callbacks.current.onToken("");
    setStatus({ enabled: false, error: "" });
    (async () => {
      const auth = await callbacks.current.getAuth();
      const config = await auth.security();
      if (!live || !config.bot_protection?.enabled) return;
      const siteKey = config.bot_protection.site_key;
      const api = await recaptcha(siteKey);
      const renew = async () => {
        try {
          const token = await api.execute(siteKey, { action });
          if (live) { callbacks.current.onToken(token); setStatus({ enabled: true, error: "" }); }
        } catch {
          // No token means the server will refuse the request, so say why here: usually a content blocker or a privacy setting.
          if (live) { callbacks.current.onToken(""); setStatus({ enabled: true, error: "The sign-in protection could not check this browser. Turn off any blocker for this site, then reload." }); }
        }
        if (live) timer = setTimeout(renew, REFRESH_MS);
      };
      if (!live) return;
      setStatus({ enabled: true, error: "" });
      await renew();
    })().catch(error => live && setStatus({ enabled: true, error: error.message }));
    return () => { live = false; clearTimeout(timer); };
  }, [action, resetKey]);
  return <div className="human-check" hidden={!status.enabled && !status.error}>
    <style>{".grecaptcha-badge{visibility:hidden}"}</style>
    {status.enabled && <p className="fine">Protected by reCAPTCHA. Google’s <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer">Terms</a> apply.</p>}
    {status.error && <p role="alert">{status.error}</p>}
  </div>;
}
