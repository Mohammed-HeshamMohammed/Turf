import { useCallback, useEffect, useRef, useState } from "react";
import { DeviceMobile, EnvelopeSimple, PaperPlaneTilt, ShieldCheck, TelegramLogo } from "@phosphor-icons/react";
import { loadAuth } from "./session.jsx";

// The second step at sign-in (docs/plans/second-factor.md): the screen that asks for it after the password, and the panel that
// manages it. The auth service decides everything; these only show what it offers and send what the person chooses.

const NAMES = { totp: "Authenticator app", email: "Email", telegram: "Telegram", push: "Approve on another device" };
const ICONS = { totp: ShieldCheck, email: EnvelopeSimple, telegram: TelegramLogo, push: DeviceMobile };

/** What to call this browser in the approval prompt on the other device. */
const deviceName = () => {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "A browser";
  const system = /Windows/.test(agent) ? "Windows" : /Mac OS/.test(agent) ? "macOS" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Linux/.test(agent) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
};

/** After the password: choose how to confirm it is you, then confirm. `onDone` runs once the sign-in is complete. */
export function SecondStep({ challenge, methods, onDone }) {
  const [method, setMethod] = useState(methods.includes("totp") ? "totp" : methods[0]);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [state, setState] = useState({ busy: false, error: "", note: "" });
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const run = async work => {
    setState({ busy: true, error: "", note: "" });
    try {
      await work(await loadAuth());
    } catch (error) {
      if (alive.current) setState({ busy: false, error: error.message, note: "" });
      return;
    }
    if (alive.current) setState(s => ({ ...s, busy: false }));
  };

  // An approval on another device: ask once, then wait for the answer.
  useEffect(() => {
    if (method !== "push" || !sent) return undefined;
    let live = true;
    const watch = setInterval(async () => {
      try {
        const auth = await loadAuth();
        const answer = await auth.approvalState(challenge);
        if (!live) return;
        if (answer === "approved") {
          clearInterval(watch);
          await auth.answer(challenge, "push");
          if (live) onDone();
        } else if (answer === "denied" || answer === "expired") {
          clearInterval(watch);
          setSent(false);
          setState({ busy: false, error: answer === "denied" ? "The sign-in was denied on your other device." : "No one answered in time. Try again.", note: "" });
        }
      } catch (error) {
        if (live) {
          clearInterval(watch);
          setState({ busy: false, error: error.message, note: "" });
        }
      }
    }, 2000);
    return () => {
      live = false;
      clearInterval(watch);
    };
  }, [method, sent, challenge, onDone]);

  const choose = next => {
    setMethod(next);
    setSent(false);
    setCode("");
    setState({ busy: false, error: "", note: "" });
  };
  const send = () =>
    run(async auth => {
      await auth.sendCode(challenge, method, method === "push" ? deviceName() : undefined);
      setSent(true);
      setState({ busy: false, error: "", note: method === "push" ? "Open Caller Whale on your other device and approve this sign-in." : `We sent a code by ${NAMES[method].toLowerCase()}.` });
    });
  const confirm = event => {
    event.preventDefault();
    run(async auth => {
      await auth.answer(challenge, method, code.trim());
      onDone();
    });
  };
  const needsCode = method === "totp" || ((method === "email" || method === "telegram") && sent);

  return (
    <div className="second-step">
      <h2>Confirm it is you</h2>
      {methods.length > 1 && (
        <div className="second-methods" role="group" aria-label="How to confirm">
          {methods.map(item => {
            const Icon = ICONS[item];
            return (
              <button key={item} type="button" className="button ghost small" aria-pressed={method === item} onClick={() => choose(item)}>
                <Icon size={16} aria-hidden="true" /> {NAMES[item]}
              </button>
            );
          })}
        </div>
      )}
      <form onSubmit={confirm} noValidate>
        {method === "totp" && <p className="sub small">Enter the code your authenticator app shows.</p>}
        {(method === "email" || method === "telegram") && !sent && <p className="sub small">We will send a six-digit code by {NAMES[method].toLowerCase()}.</p>}
        {needsCode && (
          <label>
            Code
            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} autoFocus required value={code} onChange={event => setCode(event.target.value)} />
          </label>
        )}
        {state.error && <p className="notice bad" role="alert">{state.error}</p>}
        {state.note && <p className="notice good" role="status">{state.note}</p>}
        {needsCode ? (
          <div className="actions">
            <button className="button" type="submit" disabled={state.busy || !code.trim()}>{state.busy ? "One moment…" : "Confirm"}</button>
            {method !== "totp" && (
              <button type="button" className="button ghost" onClick={send} disabled={state.busy}>Send again</button>
            )}
          </div>
        ) : (
          <div className="actions">
            <button className="button" type="button" onClick={send} disabled={state.busy || (method === "push" && sent)}>
              <PaperPlaneTilt size={16} aria-hidden="true" /> {method === "push" ? (sent ? "Waiting for approval…" : "Ask my other device") : "Send me a code"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

/** Sign-in requests waiting for this device to approve. Shown only while this device itself passed a second step. */
export function Approvals() {
  const [waiting, setWaiting] = useState([]);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const rows = await (await loadAuth()).approvals();
        if (live) setWaiting(rows);
      } catch {
        if (live) setWaiting([]); // no second step passed on this device, or signed out: nothing to approve
      }
    };
    poll();
    const timer = setInterval(poll, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const answer = async (item, approve) => {
    setWaiting(rows => rows.filter(row => row.id !== item.id));
    await (await loadAuth()).decide(item.id, approve).catch(() => undefined);
  };
  if (!waiting.length) return null;
  return (
    <div className="panel approvals" role="alert">
      {waiting.map(item => (
        <div key={item.id} className="approval">
          <h2><DeviceMobile size={22} weight="duotone" aria-hidden="true" /> Is this you signing in?</h2>
          <p className="sub">{item.device || "A new device"} is trying to sign in to your account, {item.at ? new Date(item.at * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "just now"}.</p>
          <div className="actions">
            <button type="button" className="button" onClick={() => answer(item, true)}>Yes, approve</button>
            <button type="button" className="button ghost" onClick={() => answer(item, false)}>No, deny</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** What is set up, and how to add or remove it. */
export function Security() {
  const [data, setData] = useState(null);
  const [add, setAdd] = useState(null);
  const [telegram, setTelegram] = useState("");
  const [form, setForm] = useState({ code: "", label: "" });
  const [state, setState] = useState({ busy: false, error: "", note: "" });

  const load = useCallback(async () => {
    try {
      setData(await (await loadAuth()).factors());
    } catch (error) {
      setState(s => ({ ...s, error: error.message }));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (work, note = "") => {
    setState({ busy: true, error: "", note: "" });
    try {
      await work(await loadAuth());
      setState({ busy: false, error: "", note });
      await load();
    } catch (error) {
      setState({ busy: false, error: error.message, note: "" });
    }
  };

  if (!data) return state.error ? <div className="panel"><p className="notice bad" role="alert">{state.error}</p></div> : null;
  const devices = data.factors.filter(item => item.kind === "totp");
  const linked = data.factors.find(item => item.kind === "telegram");
  return (
    <div className="panel security">
      <h2><ShieldCheck size={22} weight="duotone" aria-hidden="true" /> Two-step sign-in</h2>
      <p className="sub">After your password, confirm it is you with an authenticator app, a code by email or Telegram, or an approval on another device you are signed in on.</p>

      <h3>Authenticator app <span className="opt">({devices.length} of {data.max_totp} devices)</span></h3>
      <ul className="factor-list">
        {devices.map(item => (
          <li key={item.id}>
            <span>{item.label}<small> · added {new Date(item.created_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}{item.last_used_at ? `, last used ${new Date(item.last_used_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}</small></span>
            <button type="button" className="text-button" disabled={state.busy} onClick={() => run(auth => auth.removeFactor(item.id), "Removed.")}>Remove</button>
          </li>
        ))}
        {!devices.length && <li className="muted">None yet.</li>}
      </ul>
      {add ? (
        <form
          onSubmit={event => {
            event.preventDefault();
            run(async auth => {
              const done = await auth.confirmMfa(form.code.trim(), form.label.trim());
              setAdd(null);
              setForm({ code: "", label: "" });
              if (done.removed?.length) setState(s => ({ ...s, note: `Added. The oldest device (${done.removed.join(", ")}) was removed, because ${data.max_totp} is the most.` }));
            }, "Added.");
          }}
        >
          <p className="sub small">Add this key to your authenticator app, then enter the code it shows.</p>
          <code className="setup-key">{add.secret}</code>
          <p className="sub small"><a href={add.otpauth_url}>Open in an authenticator app on this device</a></p>
          <label>Name this device <span className="opt">(optional)</span><input value={form.label} maxLength={60} onChange={event => setForm({ ...form, label: event.target.value })} placeholder="My phone" /></label>
          <label>Code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} required value={form.code} onChange={event => setForm({ ...form, code: event.target.value })} /></label>
          <div className="actions">
            <button className="button" type="submit" disabled={state.busy}>Add device</button>
            <button className="button ghost" type="button" onClick={() => setAdd(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" className="button" disabled={state.busy} onClick={() => run(async auth => setAdd(await auth.setupMfa()))}>Add a device</button>
        </div>
      )}
      {devices.length >= data.max_totp && !add && <p className="sub small">Adding another device removes the oldest one.</p>}

      <h3>Email</h3>
      <p className="sub small">{data.available.email ? "A code to your email address is available whenever you sign in." : "Available once your email address is confirmed and the server can send mail."}</p>

      {data.available.telegram && (
        <>
          <h3>Telegram</h3>
          {linked ? (
            <ul className="factor-list"><li><span>Telegram is linked<small> · added {new Date(linked.created_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</small></span><button type="button" className="text-button" disabled={state.busy} onClick={() => run(auth => auth.removeFactor(linked.id), "Removed.")}>Remove</button></li></ul>
          ) : (
            <p className="sub small">Optional. Link a chat to get codes there.</p>
          )}
          <div className="actions">
            <button type="button" className="button ghost" disabled={state.busy} onClick={() => run(async auth => setTelegram((await auth.linkTelegram()).url))}>{linked ? "Link another chat" : "Link Telegram"}</button>
          </div>
          {telegram && <p className="sub small"><a href={telegram} target="_blank" rel="noreferrer">Open Telegram to finish linking</a> (the link works once, for 10 minutes).</p>}
        </>
      )}

      {state.error && <p className="notice bad" role="alert">{state.error}</p>}
      {state.note && <p className="notice good" role="status">{state.note}</p>}
    </div>
  );
}
