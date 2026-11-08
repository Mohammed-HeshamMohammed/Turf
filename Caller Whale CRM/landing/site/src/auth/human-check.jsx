import { useEffect, useRef, useState } from "react";

// Google's script, loaded once per page. The invisible kind (v3) is loaded with its key; the "I'm not a robot" box (v2) is
// loaded to be drawn where the page asks.
const scripts = new Map();
function recaptcha(siteKey, kind) {
  const src = kind === "checkbox" ? "https://www.google.com/recaptcha/api.js?render=explicit" : `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => window.grecaptcha ? window.grecaptcha.ready(() => resolve(window.grecaptcha)) : reject(new Error("The human check did not load. Reload and try again."));
      script.onerror = () => { scripts.delete(src); script.remove(); reject(new Error("The human check could not load. Check your connection, turn off any blocker for this site, then reload.")); };
      document.head.append(script);
    }));
  }
  return scripts.get(src);
}

// What the server says about the check, asked once per page (a failed answer is asked again next time).
const settings = new WeakMap();
async function protection(getAuth) {
  const auth = await getAuth();
  if (!settings.has(auth)) {
    settings.set(auth, auth.security().then(
      config => {
        const bot = config?.bot_protection || {};
        const kind = bot.kind === "checkbox" ? "checkbox" : "score";
        // The box kept for people the invisible check cannot vouch for (only with the invisible kind).
        return { enabled: Boolean(bot.enabled && bot.site_key), siteKey: bot.site_key || "", kind, fallbackKey: kind === "score" ? bot.fallback_site_key || "" : "" };
      },
      error => { settings.delete(auth); throw error; },
    ));
  }
  return settings.get(auth);
}

// The "I'm not a robot" box on the page now. A page shows one at a time.
let box = null;

// With the invisible check, a person it cannot vouch for gets the box too (the server says so in its refusal, and auth-client.js turns that
// into this event). From then on this page takes its token from the box until it is ticked.
let fallbackBox = null;
let fallbackWanted = false;
const fallbackListeners = new Set();
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("callerwhale:human-fallback", () => {
    fallbackWanted = true;
    fallbackListeners.forEach(listener => listener());
  });
}

/**
 * The token for one request, taken the moment it is sent: Google accepts a token once.
 * Invisible kind: a new one is asked for. Checkbox kind: the ticked box's token, and the box is cleared for the next try.
 * Empty when the server has the check off.
 */
export async function humanToken(getAuth, action) {
  const config = await protection(getAuth);
  if (!config.enabled) return "";
  if (config.kind === "checkbox") {
    if (!box) throw new Error("The human check is still loading. Wait a moment, then try again.");
    const token = box.api.getResponse(box.id);
    if (!token) throw new Error("Tick “I'm not a robot” first.");
    box.api.reset(box.id); // the token is spent by this request; a second try needs a new tick
    return token;
  }
  if (fallbackWanted && config.fallbackKey) {
    if (!fallbackBox) throw new Error("The human check is still loading. Wait a moment, then try again.");
    const token = fallbackBox.api.getResponse(fallbackBox.id);
    if (!token) throw new Error("Tick “I'm not a robot” first.");
    fallbackBox.api.reset(fallbackBox.id); // spent by this request; a second try needs a new tick
    return "v2:" + token;
  }
  const api = await recaptcha(config.siteKey, "score");
  try {
    return await api.execute(config.siteKey, { action });
  } catch {
    // Usually a content blocker or a privacy setting stops Google from answering.
    throw new Error("The human check could not check this browser. Turn off any blocker for this site, then reload.");
  }
}

/** The notice Google asks for when the invisible check hides its badge. `HumanCheck` shows it itself unless told `notice={false}`. */
export function HumanNotice() {
  return <p className="fine">Protected by reCAPTCHA. Google’s <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer">Terms</a> apply.</p>;
}

/**
 * The human check on a form. With the checkbox kind it draws Google's "I'm not a robot" box, which the person ticks (Google
 * sometimes asks for pictures too). With the invisible kind nothing is ticked: it loads Google's script and shows the notice.
 * Either way, each request takes its token from `humanToken` when it is sent. `onEnabled(true)` means the page must show
 * Google's notice (the invisible kind with `notice={false}`).
 */
export function HumanCheck({ getAuth, notice = true, onEnabled }) {
  const callbacks = useRef({ getAuth, onEnabled });
  callbacks.current = { getAuth, onEnabled };
  const holder = useRef(null);
  const boxHolder = useRef(null);
  const [status, setStatus] = useState({ kind: "", error: "" });
  const [needBox, setNeedBox] = useState(fallbackWanted);
  useEffect(() => {
    const listener = () => setNeedBox(true);
    fallbackListeners.add(listener);
    return () => fallbackListeners.delete(listener);
  }, []);
  // The invisible check could not vouch for this person: draw the box, using the same Google script (it can draw both kinds).
  useEffect(() => {
    if (!needBox) return undefined;
    let live = true, mine = null;
    (async () => {
      const config = await protection(callbacks.current.getAuth);
      if (!live || !config.enabled || !config.fallbackKey) return;
      const api = await recaptcha(config.siteKey, "score");
      if (!live || !boxHolder.current) return;
      const narrow = boxHolder.current.clientWidth > 0 && boxHolder.current.clientWidth < 304;
      const id = api.render(boxHolder.current, {
        sitekey: config.fallbackKey,
        theme: "light",
        size: narrow ? "compact" : "normal",
        "error-callback": () => live && setStatus(current => ({ ...current, error: "The human check lost its connection to Google. Check your connection, then reload." })),
        callback: () => live && setStatus(current => ({ ...current, error: "" })),
      });
      mine = { api, id };
      fallbackBox = mine;
    })().catch(error => live && setStatus(current => ({ ...current, error: error.message })));
    return () => {
      live = false;
      if (fallbackBox === mine) fallbackBox = null;
    };
  }, [needBox]);
  useEffect(() => {
    let live = true, mine = null;
    (async () => {
      const config = await protection(callbacks.current.getAuth);
      if (!live || !config.enabled) return;
      setStatus({ kind: config.kind, error: "" });
      const api = await recaptcha(config.siteKey, config.kind);
      if (!live || config.kind !== "checkbox" || !holder.current) return;
      const narrow = holder.current.clientWidth > 0 && holder.current.clientWidth < 304;
      const id = api.render(holder.current, {
        sitekey: config.siteKey,
        theme: "light",
        size: narrow ? "compact" : "normal",
        "error-callback": () => live && setStatus({ kind: "checkbox", error: "The human check lost its connection to Google. Check your connection, then reload." }),
        callback: () => live && setStatus({ kind: "checkbox", error: "" }),
      });
      mine = { api, id };
      box = mine;
    })().catch(error => live && setStatus(current => ({ kind: current.kind || "score", error: error.message })));
    return () => {
      live = false;
      if (box === mine) box = null;
    };
  }, []);
  const needsNotice = status.kind === "score";
  useEffect(() => { callbacks.current.onEnabled?.(needsNotice); }, [needsNotice]);
  return <div className="human-check" hidden={!status.kind && !status.error && !needBox}>
    {needsNotice && <style>{".grecaptcha-badge{visibility:hidden}"}</style>}
    {needsNotice && notice && <HumanNotice />}
    {/* Always there, so the box can be drawn the moment Google's script is ready; empty until then. */}
    <div className="human-box" ref={holder} hidden={status.kind !== "checkbox"} />
    {needBox && status.kind === "score" && <p className="fine">We could not confirm you automatically. Tick the box below, then try again.</p>}
    <div className="human-box" ref={boxHolder} hidden={!needBox || status.kind !== "score"} />
    {status.error && <p role="alert">{status.error}</p>}
  </div>;
}
