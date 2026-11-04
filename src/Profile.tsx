import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { Link } from "./nav.tsx";
import { RoleBadges, type Access } from "./RoleBadges.tsx";

export function Profile({ me, auth, authBase, onSaved }: { me: Me; auth: Auth; authBase: string; onSaved: () => void }) {
  const [name, setName] = useState(me.name || "");
  const [phone, setPhone] = useState(String(me.phone || ""));
  const [avatar, setAvatar] = useState(String(me.avatar || ""));
  const [access, setAccess] = useState<Access | null>(null);
  const [accessStatus, setAccessStatus] = useState<"loading" | "ready" | "service" | "session" | "error">("loading");
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [providers, setProviders] = useState<string[]>([]);
  const [available, setAvailable] = useState<{ google?: boolean; apple?: boolean }>({});
  const [state, setState] = useState({ busy: false, message: "", error: "" });
  useEffect(() => { setName(me.name || ""); setPhone(String(me.phone || "")); setAvatar(String(me.avatar || "")); }, [me.id, me.name, me.phone, me.avatar]);
  useEffect(() => {
    let active = true;
    auth.accessToken().then(async token => {
      if (!token) { if (active) setAccessStatus("session"); return; }
      const headers = { Authorization: `Bearer ${token}` };
      fetch(`${authBase}/v1/me/providers`, { headers }).then(r => r.ok ? r.json() : null).then(linked => { if (active) setProviders(linked?.providers || []); }).catch(() => {});
      const response = await fetch(`${authBase}/v1/me/access`, { headers });
      if (!response.ok) { if (active) setAccessStatus(response.status === 503 ? "service" : response.status === 401 ? "session" : "error"); return; }
      const role = await response.json() as Access;
      if (active) { setAccess(role); setAccessStatus("ready"); }
    }).catch(() => { if (active) setAccessStatus("error"); });
    auth.providers().then(result => { if (active) setAvailable(result); }).catch(() => {});
    return () => { active = false; };
  }, [auth, authBase, me.id, accessAttempt]);
  const picture = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!(["image/png", "image/jpeg"].includes(file.type)) || file.size > 100000) {
      setState({ busy: false, message: "", error: "Choose a PNG or JPEG image smaller than 100 KB." });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") setAvatar(reader.result); };
    reader.readAsDataURL(file);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setState({ busy: true, message: "", error: "" });
    try {
      const token = await auth.accessToken();
      if (!token) throw new Error("Sign in again to save your profile.");
      const response = await fetch(`${authBase}/v1/me/profile`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim(), avatar }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Your profile could not be saved.");
      setState({ busy: false, message: "Profile saved.", error: "" });
      onSaved();
    } catch (error) { setState({ busy: false, message: "", error: error instanceof Error ? error.message : "Could not save your profile." }); }
  };
  const link = async (provider: "google" | "apple") => {
    setState({ busy: true, message: "", error: "" });
    try {
      const token = await auth.accessToken();
      if (!token) throw new Error("Sign in again to link an account.");
      const response = await fetch(`${authBase}/v1/me/providers/${provider}/start`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Could not connect ${provider}.`);
      window.location.assign(result.url);
    } catch (error) { setState({ busy: false, message: "", error: error instanceof Error ? error.message : "Could not link the account." }); }
  };
  const linked = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("linked");
  const linkError = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("link_error");
  return <div className="profile-page">
    <header className="page-head profile-head"><div className="profile-avatar" aria-hidden="true">{avatar ? <img src={avatar} alt="" /> : (name || me.email).charAt(0).toUpperCase()}</div><div><span className="eyebrow">Your account</span><h1>Your profile</h1><p className="lead">Manage your identity and sign-in methods.</p>{access && <RoleBadges access={access} />}</div></header>
    <div className="profile-grid"><form className="card profile-card" onSubmit={save}><h2>Personal details</h2><div className="profile-fields"><label>Display name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>Email<input value={me.email} readOnly aria-readonly="true" /></label><label>Phone number<input type="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="Optional" autoComplete="tel" /></label><label>Profile picture<input type="file" accept="image/png,image/jpeg" onChange={picture} /></label></div>{avatar && <button className="text-button" type="button" onClick={() => setAvatar("")}>Remove picture</button>}<button className="button primary" disabled={state.busy}>{state.busy ? "Saving…" : "Save changes"}</button>{state.message && <p role="status" className="notice good">{state.message}</p>}{state.error && <p role="alert" className="notice bad">{state.error}</p>}</form>
      <section className="card profile-card"><h2>Access and roles</h2>{accessStatus === "ready" && access ? <><RoleBadges access={access} /><p className="muted">{access.workspaces.length ? `${access.workspaces.length} workspace membership${access.workspaces.length === 1 ? "" : "s"}` : "No workspace memberships yet."}</p></> : <p className="muted" role="status">{accessStatus === "loading" ? "Checking your roles…" : accessStatus === "service" ? "Authorization is unavailable (503). The site cannot read roles until auth and authz are connected." : accessStatus === "session" ? "Your session ended. Sign in again to see your roles." : "Could not load roles. Check the auth connection and try again."}</p>}{accessStatus !== "ready" && accessStatus !== "loading" && <button type="button" className="button" onClick={() => { setAccessStatus("loading"); setAccessAttempt(n => n + 1); }}>Retry roles</button>}<Link to="/dashboard">Go to dashboard →</Link></section>
      <section className="card profile-card"><h2>Connected accounts</h2><p className="muted">Connect a sign-in method to this same Caller Whale account.</p><div className="profile-providers">{(["google", "apple"] as const).map(provider => <div key={provider}><span>{provider === "google" ? "Google" : "Apple"}</span>{providers.includes(provider) ? <span className="role-badge">Connected</span> : available[provider] ? <button type="button" className="button" disabled={state.busy} onClick={() => void link(provider)}>Connect</button> : <span className="muted">Unavailable</span>}</div>)}</div>{linked && <p role="status" className="notice good">{linked === "apple" ? "Apple" : "Google"} connected.</p>}{linkError && <p role="alert" className="notice bad">{linkError}</p>}<p className="muted">You may need to sign in again before linking a method.</p></section></div>
  </div>;
}
