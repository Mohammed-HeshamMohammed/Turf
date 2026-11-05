import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Auth, Me } from "./auth/auth-client.js";

type Factors = Awaited<ReturnType<Auth["factors"]>>;

const Busy = ({ busy, label }: { busy: boolean; label: string }) => busy ? <><span className="spinner" aria-hidden="true" />Working…</> : <>{label}</>;
const when = (seconds: number | null) => seconds ? new Date(seconds * 1000).toLocaleDateString() : "never";
const problem = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/** Settings, Security: every way of answering the second step, each turned on or off here. */
export function SettingsSecurity({ me, auth, onChanged }: { me: Me; auth: Auth; onChanged: () => void }) {
  const [data, setData] = useState<Factors | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [waitingTelegram, setWaitingTelegram] = useState(false);

  const load = useCallback(async () => {
    try { setData(await auth.factors()); setLoadError(""); }
    catch (error) { setLoadError(problem(error, "Could not load your sign-in security.")); }
  }, [auth]);
  useEffect(() => { void load(); }, [load]);

  // The Telegram bot answers in another app, so look again every few seconds until the chat shows up (or ten minutes pass).
  useEffect(() => {
    if (!waitingTelegram) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const latest = await auth.factors();
        if (latest.factors.some(item => item.kind === "telegram")) { setData(latest); setWaitingTelegram(false); onChanged(); }
        else if (Date.now() - started > 10 * 60 * 1000) setWaitingTelegram(false);
      } catch { /* try again on the next tick */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [waitingTelegram, auth, onChanged]);

  useEffect(() => {
    if (!setup) { setQr(""); return; }
    let live = true;
    import("qrcode").then(({ toDataURL }) => toDataURL(setup.otpauth_url, { margin: 1, width: 192 })).then(url => { if (live) setQr(url); }).catch(() => {});
    return () => { live = false; };
  }, [setup]);

  const act = async (name: string, work: () => Promise<string | void>) => {
    setBusy(name); setMessage(null);
    try { const text = await work(); if (text) setMessage({ tone: "good", text }); await load(); onChanged(); }
    catch (error) { setMessage({ tone: "bad", text: problem(error, "That did not work. Try again.") }); }
    setBusy("");
  };

  if (loadError) return <p className="notice bad" role="alert">{loadError} <button type="button" className="text-button" onClick={() => void load()}>Try again</button></p>;
  if (!data) return <p className="muted" role="status"><span className="spinner" aria-hidden="true" />Loading…</p>;

  const devices = data.factors.filter(item => item.kind === "totp");
  const telegram = data.factors.find(item => item.kind === "telegram");
  const enrolled = data.factors.length > 0;

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void act("confirm", async () => {
      const result = await auth.confirmMfa(code.trim());
      setRecovery(result.recovery_codes);
      setSetup(null); setCode("");
      return "Authenticator added.";
    });
  };
  const downloadCodes = () => {
    const url = URL.createObjectURL(new Blob([`Caller Whale recovery codes\n\n${recovery.join("\n")}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url; link.download = "caller-whale-recovery-codes.txt"; link.click();
    URL.revokeObjectURL(url);
  };
  const turnOff = () => {
    if (!confirm_("Turn off two-step sign-in? Your account will be protected by your password alone.")) return;
    void act("off", async () => {
      for (const item of data.factors) await auth.removeFactor(item.id);
      setSetup(null); setRecovery([]);
      return "Two-step sign-in is off.";
    });
  };

  return (
    <div className="settings-stack">
      <section className="card profile-card" aria-labelledby="two-step-title">
        <div className="profile-card-head">
          <h2 id="two-step-title">Two-step sign-in</h2>
          <span className={`role-badge${enrolled ? "" : " is-off"}`}>{enrolled ? "On" : "Off"}</span>
        </div>
        <p className="muted">{enrolled ? "After your password, we ask for a code or an approval. Choose which ways you can use below." : "Add a second check after your password. Turn on at least one way below."}</p>
        {message && <p role={message.tone === "bad" ? "alert" : "status"} className={`notice ${message.tone}`}>{message.text}</p>}
        {enrolled && <div><button type="button" className="button" disabled={Boolean(busy)} onClick={turnOff}><Busy busy={busy === "off"} label="Turn off two-step sign-in" /></button></div>}
      </section>

      {recovery.length > 0 && (
        <section className="card profile-card" aria-labelledby="recovery-title">
          <h2 id="recovery-title">Save your recovery codes</h2>
          <p className="muted">Each works once if you lose your authenticator. They are shown only now.</p>
          <pre className="recovery-codes">{recovery.join("\n")}</pre>
          <div className="profile-picture-actions"><button type="button" className="button" onClick={downloadCodes}>Download</button><button type="button" className="button primary" onClick={() => setRecovery([])}>I saved them</button></div>
        </section>
      )}

      <section className="card profile-card" aria-labelledby="totp-title">
        <div className="profile-card-head"><h2 id="totp-title">Authenticator app</h2><span className={`role-badge${devices.length ? "" : " is-off"}`}>{devices.length ? `${devices.length} on` : "Off"}</span></div>
        <p className="muted">Codes from an app such as Google Authenticator, 1Password or Authy. Up to {data.max_totp} devices.</p>
        {devices.length > 0 && <ul className="settings-list">{devices.map(item => (
          <li key={item.id}><span><strong>{item.label || "Authenticator"}</strong><small className="muted">Added {when(item.created_at)} · last used {when(item.last_used_at)}</small></span>
            <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => { if (confirm_("Remove this authenticator?")) void act("remove-" + item.id, async () => { await auth.removeFactor(item.id); return "Authenticator removed."; }); }}>Remove</button></li>
        ))}</ul>}
        {setup ? (
          <form className="settings-setup" onSubmit={confirm}>
            {qr ? <img src={qr} width="192" height="192" alt="QR code for your authenticator app" /> : <span className="muted">Preparing the code…</span>}
            <p className="muted">Scan it with your app, or type this key: <code>{setup.secret}</code></p>
            <label className="field">Six-digit code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,8}" required value={code} onChange={event => setCode(event.target.value)} /></label>
            <div className="profile-picture-actions"><button className="button primary" disabled={Boolean(busy) || !code.trim()}><Busy busy={busy === "confirm"} label="Confirm" /></button><button type="button" className="text-button" onClick={() => { setSetup(null); setCode(""); }}>Cancel</button></div>
          </form>
        ) : (
          <div><button type="button" className="button" disabled={Boolean(busy)} onClick={() => void act("setup", async () => { setSetup(await auth.setupMfa()); })}><Busy busy={busy === "setup"} label={devices.length ? "Add another device" : "Set up an authenticator"} /></button></div>
        )}
      </section>

      <section className="card profile-card" aria-labelledby="email-title">
        <div className="profile-card-head"><h2 id="email-title">Email codes</h2><span className={`role-badge${enrolled && data.available.email && data.email_enabled ? "" : " is-off"}`}>{enrolled && data.available.email && data.email_enabled ? "On" : "Off"}</span></div>
        <p className="muted">A code sent to {me.email}.</p>
        {!data.available.email ? <p className="muted">Available once your email address is confirmed.</p>
          : !enrolled ? <p className="muted">Turn on an authenticator or Telegram first, then you can add email codes.</p>
          : <label className="check"><input type="checkbox" checked={data.email_enabled} disabled={Boolean(busy)} onChange={event => void act("email", async () => { await auth.setEmailCodes(event.target.checked); return event.target.checked ? "Email codes are on." : "Email codes are off."; })} /> <span>Use email codes for the second step</span></label>}
      </section>

      <section className="card profile-card" aria-labelledby="telegram-title">
        <div className="profile-card-head"><h2 id="telegram-title">Telegram</h2><span className={`role-badge${telegram ? "" : " is-off"}`}>{telegram ? "Connected" : "Off"}</span></div>
        <p className="muted">Receive the code in a Telegram chat with the Caller Whale bot.</p>
        {!data.available.telegram ? <p className="muted">Not available right now.</p>
          : telegram ? <div><button type="button" className="button" disabled={Boolean(busy)} onClick={() => { if (confirm_("Disconnect Telegram?")) void act("telegram-off", async () => { await auth.removeFactor(telegram.id); return "Telegram disconnected."; }); }}><Busy busy={busy === "telegram-off"} label="Disconnect" /></button></div>
          : waitingTelegram ? <p className="muted" role="status"><span className="spinner" aria-hidden="true" />Waiting for you to press Start in Telegram…</p>
          : <div><button type="button" className="button" disabled={Boolean(busy)} onClick={() => void act("telegram", async () => { const link = await auth.linkTelegram(); window.open(link.url, "_blank", "noopener"); setWaitingTelegram(true); })}><Busy busy={busy === "telegram"} label="Connect Telegram" /></button></div>}
      </section>

      <section className="card profile-card" aria-labelledby="device-title">
        <div className="profile-card-head"><h2 id="device-title">Approve on another device</h2><span className={`role-badge${data.available.push ? "" : " is-off"}`}>{data.available.push ? "Available" : "Off"}</span></div>
        <p className="muted">Approve a sign-in from a device where you are already signed in. It turns on by itself once you are signed in with a second step on another device.</p>
      </section>

      <section className="card profile-card" aria-labelledby="phone-title">
        <div className="profile-card-head"><h2 id="phone-title">Text message</h2><span className="role-badge is-off">Coming soon</span></div>
        <p className="muted">Codes by text message to your phone number are not available yet.</p>
      </section>
    </div>
  );
}

// The browser's own confirmation box, under a name that does not clash with the `confirm` handler above.
const confirm_ = (text: string) => window.confirm(text);
