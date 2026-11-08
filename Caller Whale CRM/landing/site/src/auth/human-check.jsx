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

// What the server says about the check, asked once per page (a failed answer is asked again next time).
const settings = new WeakMap();
async function protection(getAuth) {
  const auth = await getAuth();
  if (!settings.has(auth)) settings.set(auth, auth.security().then(config => config?.bot_protection || { enabled: false }, error => { settings.delete(auth); throw error; }));
  return settings.get(auth);
}

/**
 * A new token for one request, asked for the moment it is sent. Google accepts a token once and for two minutes, so a token kept
 * from earlier fails a second try ("Verify you are human"). Empty when the server has the check off.
 */
export async function humanToken(getAuth, action) {
  const config = await protection(getAuth);
  if (!config.enabled || !config.site_key) return "";
  const api = await recaptcha(config.site_key);
  try {
    return await api.execute(config.site_key, { action });
  } catch {
    // Usually a content blocker or a privacy setting stops Google from answering.
    throw new Error("The sign-in protection could not check this browser. Turn off any blocker for this site, then reload.");
  }
}

/** The notice Google asks for when its badge is hidden. `HumanCheck` shows it itself unless told `notice={false}`, for a page that puts it elsewhere. */
export function HumanNotice() {
  return <p className="fine">Protected by reCAPTCHA. Google’s <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer">Terms</a> apply.</p>;
}

/**
 * Invisible: nobody ticks anything. Google scores the visit and the gateway refuses a low score, so a person acting like a person
 * never sees a challenge. This loads Google's script early (when the server has the check on) and shows the notice, or why the
 * check cannot run; each request gets its own token from `humanToken` when it is sent.
 */
export function HumanCheck({ getAuth, notice = true, onEnabled }) {
  const callbacks = useRef({ getAuth, onEnabled });
  callbacks.current = { getAuth, onEnabled };
  const [status, setStatus] = useState({ enabled: false, error: "" });
  useEffect(() => {
    let live = true;
    (async () => {
      const config = await protection(callbacks.current.getAuth);
      if (!live || !config.enabled || !config.site_key) return;
      setStatus({ enabled: true, error: "" });
      await recaptcha(config.site_key);
    })().catch(error => live && setStatus({ enabled: true, error: error.message }));
    return () => { live = false; };
  }, []);
  useEffect(() => { callbacks.current.onEnabled?.(status.enabled); }, [status.enabled]);
  return <div className="human-check" hidden={!status.enabled && !status.error}>
    <style>{".grecaptcha-badge{visibility:hidden}"}</style>
    {status.enabled && notice && <HumanNotice />}
    {status.error && <p role="alert">{status.error}</p>}
  </div>;
}
