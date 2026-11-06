import { useEffect, useState } from "react";
import type { Auth } from "./auth/auth-client.js";
import { askedFrom, returnKind } from "./connect-check.ts";


const SCOPE_TEXT: Record<string, string> = { "account:read": "See your name, your email, your role and your workspaces, and how much of your plan you have used" };

/** The consent page an assistant sends the person to. Allowing hands the assistant a code; nothing is shared before that. */
export function Connect({ auth, authBase, search }: { auth: Auth; authBase: string; search: string }) {
  const asked = askedFrom(search);
  const [client, setClient] = useState<{ name: string; return_host: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "allow" | "deny">("");

  useEffect(() => {
    if (!asked) return;
    let live = true;
    fetch(`${authBase}/v1/connectors/clients/${encodeURIComponent(asked.clientId)}?redirect_uri=${encodeURIComponent(asked.redirectUri)}`)
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "This request is not valid.");
        if (live) setClient(body);
      })
      .catch(reason => { if (live) setError(reason instanceof Error ? reason.message : "This request is not valid."); });
    return () => { live = false; };
  }, [search]);

  if (!asked) return <div className="form-wrap"><div className="form card"><h1>Connect an assistant</h1><p className="notice bad" role="alert">This page opens from an assistant such as Claude, ChatGPT or Gemini. Add Caller Whale there, and it brings you back here.</p></div></div>;

  const decide = async (deny: boolean) => {
    setBusy(deny ? "deny" : "allow"); setError("");
    try {
      const token = await auth.accessToken();
      if (!token) throw new Error("Sign in again to continue.");
      const response = await fetch(`${authBase}/v1/connectors/consent`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: asked.clientId, redirect_uri: asked.redirectUri, scope: asked.scope, state: asked.state, code_challenge: asked.challenge, deny }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not finish connecting.");
      window.location.assign(body.redirect);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not finish connecting.");
      setBusy("");
    }
  };

  const scopes = asked.scope.split(" ").filter(item => SCOPE_TEXT[item]);
  return (
    <div className="form-wrap">
      <div className="form card connect-card">
        <h1>{client ? `Connect ${client.name}?` : "Connect an assistant"}</h1>
        {client ? (
          <>
            <p className="muted"><strong>{client.name}</strong> is asking to use your Caller Whale account. It will return you to <strong>{client.return_host}</strong>.</p>
            <div>
              <p><strong>It will be able to:</strong></p>
              <ul className="connect-list">{scopes.map(item => <li key={item}>{SCOPE_TEXT[item]}</li>)}</ul>
              <p><strong>It will not be able to:</strong></p>
              <ul className="connect-list"><li>Change anything in your account</li><li>See or change leads, calls, messages or payments</li></ul>
            </div>
            {returnKind(client.return_host) === "unknown" && <p className="notice bad" role="alert"><strong>Caller Whale does not recognise this app.</strong> Its name is chosen by whoever made it, so it may not be what it says. Only allow it if you started this yourself from an app you trust.</p>}
            {returnKind(client.return_host) === "local" && <p className="notice">This app runs on your own computer. Only allow it if you started it yourself.</p>}
            <p className="muted">You can end this connection any time in Settings → Connections.</p>
          </>
        ) : !error && <p className="muted" role="status"><span className="spinner" aria-hidden="true" />Checking the request…</p>}
        {error && <p className="notice bad" role="alert">{error}</p>}
        <div className="notice-actions">
          <button type="button" className="button primary" disabled={!client || Boolean(busy)} onClick={() => void decide(false)}>{busy === "allow" ? <><span className="spinner" aria-hidden="true" />Connecting…</> : "Allow"}</button>
          <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void decide(true)}>{busy === "deny" ? "Cancelling…" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
}
