import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { Link } from "./nav.tsx";
import { RoleBadges, type Access } from "./RoleBadges.tsx";
import { MainCurrency } from "./MainCurrency.tsx";
import { AvatarCropper } from "./AvatarCropper.tsx";

export function Profile({ me, auth, authBase, onSaved }: { me: Me; auth: Auth; authBase: string; onSaved: () => void }) {
  const [name, setName] = useState(me.name || "");
  const [phone, setPhone] = useState(String(me.phone || ""));
  const savedAvatar = String(me.avatar || "");
  // A picture chosen and cropped but not saved yet (an empty text means "remove it"); null when nothing is waiting.
  const [staged, setStaged] = useState<string | null>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const [pictureState, setPictureState] = useState({ busy: false, message: "", error: "" });
  const avatar = staged ?? savedAvatar;
  const [access, setAccess] = useState<Access | null>(null);
  const [accessStatus, setAccessStatus] = useState<"loading" | "ready" | "service" | "session" | "error">("loading");
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [providers, setProviders] = useState<string[]>([]);
  const [available, setAvailable] = useState<{ google?: boolean; apple?: boolean }>({});
  const [state, setState] = useState({ busy: false, message: "", error: "" });
  useEffect(() => { setName(me.name || ""); setPhone(String(me.phone || "")); }, [me.id, me.name, me.phone]);
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
  const pictureInput = useRef<HTMLInputElement>(null);
  const picture = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // choosing the same file again still counts
    if (!file) return;
    setPictureState({ busy: false, message: "", error: "" });
    setCropping(file);
  };
  // The picture is saved on its own, with the details as they are saved now; the details form saves the details with the picture as it is saved now.
  const post = async (body: { name: string; phone: string; avatar: string }) => {
    const token = await auth.accessToken();
    if (!token) throw new Error("Sign in again to save your profile.");
    const response = await fetch(`${authBase}/v1/me/profile`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Your profile could not be saved.");
  };
  const savePicture = async () => {
    if (staged === null) return;
    setPictureState({ busy: true, message: "", error: "" });
    try {
      await post({ name: me.name || "", phone: String(me.phone || ""), avatar: staged });
      setStaged(null);
      setPictureState({ busy: false, message: staged ? "Picture saved." : "Picture removed.", error: "" });
      onSaved();
    } catch (error) { setPictureState({ busy: false, message: "", error: error instanceof Error ? error.message : "Could not save your picture." }); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setState({ busy: true, message: "", error: "" });
    try {
      await post({ name: name.trim(), phone: phone.trim(), avatar: savedAvatar });
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
    <header className="page-head profile-head"><button type="button" className="profile-avatar profile-avatar-button" aria-label="Change profile picture" title="Change profile picture" onClick={() => pictureInput.current?.click()}>{avatar ? <img src={avatar} alt="" /> : (name || me.email).charAt(0).toUpperCase()}<span className="profile-avatar-change" aria-hidden="true">Change</span></button><input ref={pictureInput} type="file" hidden accept="image/*" onChange={picture} /><div><span className="eyebrow">Your account</span><h1>Your profile</h1><p className="lead">Manage your identity and sign-in methods.</p>{access && <RoleBadges access={access} />}</div></header>
    <section className="card profile-picture" aria-labelledby="profile-picture-title"><div><h2 id="profile-picture-title">Profile picture</h2><p className="muted">Press your picture above and choose any image. You can move and zoom it, and we resize it for you.</p></div><div className="profile-picture-actions">{staged !== null ? <><button type="button" className="button primary" disabled={pictureState.busy} onClick={() => void savePicture()}>{pictureState.busy ? "Saving…" : "Save picture"}</button><button type="button" className="button" disabled={pictureState.busy} onClick={() => setStaged(null)}>Discard</button></> : <><button type="button" className="button" onClick={() => pictureInput.current?.click()}>{savedAvatar ? "Change picture" : "Choose picture"}</button>{savedAvatar && <button type="button" className="text-button" onClick={() => setStaged("")}>Remove picture</button>}</>}</div>{pictureState.message && <p role="status" className="notice good">{pictureState.message}</p>}{pictureState.error && <p role="alert" className="notice bad">{pictureState.error}</p>}</section>
    {cropping && <AvatarCropper file={cropping} onCancel={() => setCropping(null)} onDone={dataUrl => { setStaged(dataUrl); setCropping(null); }} />}
    <div className="profile-grid"><form className="card profile-card" onSubmit={save}><h2>Personal details</h2><div className="profile-fields"><label>Display name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>Email<input value={me.email} readOnly aria-readonly="true" /></label><label>Phone number<input type="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="Optional" autoComplete="tel" /></label></div><button className="button primary" disabled={state.busy}>{state.busy ? "Saving…" : "Save changes"}</button>{state.message && <p role="status" className="notice good">{state.message}</p>}{state.error && <p role="alert" className="notice bad">{state.error}</p>}</form>
      <section className="card profile-card"><h2>Access and roles</h2>{accessStatus === "ready" && access ? <><RoleBadges access={access} /><p className="muted">{access.workspaces.length ? `${access.workspaces.length} workspace membership${access.workspaces.length === 1 ? "" : "s"}` : "No workspace memberships yet."}</p></> : <p className="muted" role="status">{accessStatus === "loading" ? "Checking your roles…" : accessStatus === "service" ? "Authorization is unavailable (503). The site cannot read roles until auth and authz are connected." : accessStatus === "session" ? "Your session ended. Sign in again to see your roles." : "Could not load roles. Check the auth connection and try again."}</p>}{accessStatus !== "ready" && accessStatus !== "loading" && <button type="button" className="button" onClick={() => { setAccessStatus("loading"); setAccessAttempt(n => n + 1); }}>Retry roles</button>}<Link to="/dashboard">Go to dashboard →</Link></section>
      <section className="card profile-card"><h2>Connected accounts</h2><p className="muted">Connect a sign-in method to this same Caller Whale account.</p><div className="profile-providers">{(["google", "apple"] as const).map(provider => <div key={provider}><span>{provider === "google" ? "Google" : "Apple"}</span>{providers.includes(provider) ? <span className="role-badge">Connected</span> : available[provider] ? <button type="button" className="button" disabled={state.busy} onClick={() => void link(provider)}>Connect</button> : <span className="muted">Unavailable</span>}</div>)}</div>{linked && <p role="status" className="notice good">{linked === "apple" ? "Apple" : "Google"} connected.</p>}{linkError && <p role="alert" className="notice bad">{linkError}</p>}<p className="muted">You may need to sign in again before linking a method.</p></section>
      <MainCurrency auth={auth} authBase={authBase} saved={String(me.currency || "")} onSaved={onSaved} /></div>
  </div>;
}
