import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { RoleBadges, type Access } from "./RoleBadges.tsx";
import { MainCurrency } from "./MainCurrency.tsx";
import { AvatarCropper } from "./AvatarCropper.tsx";

export function Profile({ me, auth, authBase, onSaved }: { me: Me; auth: Auth; authBase: string; onSaved: () => void }) {
  const [name, setName] = useState(me.name || "");
  const [phone, setPhone] = useState(String(me.phone || ""));
  const savedAvatar = String(me.avatar || "");
  const [cropping, setCropping] = useState<File | null>(null);
  const [pictureState, setPictureState] = useState({ busy: false, message: "", error: "" });
  const avatar = savedAvatar;
  const [access, setAccess] = useState<Access | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [available, setAvailable] = useState<{ google?: boolean; apple?: boolean }>({});
  const [state, setState] = useState({ busy: false, message: "", error: "" });
  useEffect(() => { setName(me.name || ""); setPhone(String(me.phone || "")); }, [me.id, me.name, me.phone]);
  useEffect(() => {
    let active = true;
    auth.accessToken().then(async token => {
      if (!token) return;
      const headers = { Authorization: `Bearer ${token}` };
      fetch(`${authBase}/v1/me/providers`, { headers }).then(r => r.ok ? r.json() : null).then(linked => { if (active) setProviders(linked?.providers || []); }).catch(() => {});
      const response = await fetch(`${authBase}/v1/me/access`, { headers });
      if (!response.ok) return; // the role badges simply do not appear
      const role = await response.json() as Access;
      if (active) setAccess(role);
    }).catch(() => {});
    auth.providers().then(result => { if (active) setAvailable(result); }).catch(() => {});
    return () => { active = false; };
  }, [auth, authBase, me.id]);
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
  // Saving a picture saves it at once, on its own (the name and phone stay as they are saved now). Answers a problem to show, if any.
  const savePicture = async (dataUrl: string): Promise<string | void> => {
    setPictureState({ busy: true, message: "", error: "" });
    try {
      await post({ name: me.name || "", phone: String(me.phone || ""), avatar: dataUrl });
      setPictureState({ busy: false, message: dataUrl ? "Picture saved." : "Picture removed.", error: "" });
      setCropping(null);
      onSaved();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Could not save your picture.";
      setPictureState({ busy: false, message: "", error: dataUrl ? "" : text });
      return text;
    }
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
    <header className="page-head profile-head"><button type="button" className="profile-avatar profile-avatar-button" aria-label="Change profile picture" title="Change profile picture" onClick={() => pictureInput.current?.click()}>{avatar ? <img src={avatar} alt="" /> : (name || me.email).charAt(0).toUpperCase()}<span className="profile-avatar-change" aria-hidden="true">Change</span></button><input ref={pictureInput} type="file" hidden accept="image/*" onChange={picture} /><div><h1>Your profile</h1>{access && <RoleBadges access={access} />}<div className="profile-picture-actions"><button type="button" className="button" disabled={pictureState.busy} onClick={() => pictureInput.current?.click()}>{savedAvatar ? "Change picture" : "Choose picture"}</button>{savedAvatar && <button type="button" className="text-button" disabled={pictureState.busy} onClick={() => void savePicture("")}>Remove</button>}</div>{pictureState.message && <p role="status" className="notice good">{pictureState.message}</p>}{pictureState.error && <p role="alert" className="notice bad">{pictureState.error}</p>}</div></header>
    {cropping && <AvatarCropper file={cropping} onCancel={() => setCropping(null)} onDone={savePicture} />}
    <div className="profile-grid"><form className="card profile-card" onSubmit={save}><h2>Personal details</h2><div className="profile-fields"><label>Display name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>Email<input value={me.email} readOnly aria-readonly="true" /></label><label>Phone number<input type="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="Optional" autoComplete="tel" /></label></div><button className="button primary" disabled={state.busy}>{state.busy ? "Saving…" : "Save changes"}</button>{state.message && <p role="status" className="notice good">{state.message}</p>}{state.error && <p role="alert" className="notice bad">{state.error}</p>}</form>
      <section className="card profile-card"><h2>Connected accounts</h2><div className="profile-providers">{(["google", "apple"] as const).map(provider => <div key={provider}><span>{provider === "google" ? "Google" : "Apple"}</span>{providers.includes(provider) ? <span className="role-badge">Connected</span> : available[provider] ? <button type="button" className="button" disabled={state.busy} onClick={() => void link(provider)}>Connect</button> : <span className="muted">Unavailable</span>}</div>)}</div>{linked && <p role="status" className="notice good">{linked === "apple" ? "Apple" : "Google"} connected.</p>}{linkError && <p role="alert" className="notice bad">{linkError}</p>}</section>
      <MainCurrency auth={auth} authBase={authBase} saved={String(me.currency || "")} onSaved={onSaved} /></div>
  </div>;
}
