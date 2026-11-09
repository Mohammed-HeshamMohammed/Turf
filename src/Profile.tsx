import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { RoleBadges, type Access } from "./RoleBadges.tsx";
import { MainCurrency } from "./MainCurrency.tsx";
import { AvatarCropper } from "./AvatarCropper.tsx";
import { namePartsOf } from "./person-name.ts";

/** The address of the person's own page. Saved on its own, like the picture. */
function UsernameCard({ me, auth, authBase, onSaved }: { me: Me; auth: Auth; authBase: string; onSaved: () => void }) {
  const saved = String(me.username || "");
  const [value, setValue] = useState(saved);
  const [state, setState] = useState({ busy: false, message: "", error: "" });
  useEffect(() => setValue(saved), [saved]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState({ busy: true, message: "", error: "" });
    try {
      const token = await auth.accessToken();
      if (!token) throw new Error("Sign in again to save your username.");
      const response = await fetch(`${authBase}/v1/me/username`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ username: value.trim() }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Your username could not be saved.");
      setState({ busy: false, message: "Username saved.", error: "" });
      onSaved();
      // This page is at the old address: move to the new one.
      if (typeof window !== "undefined" && window.location.pathname === `/${saved}`) window.history.replaceState(null, "", `/${result.username}`);
    } catch (error) { setState({ busy: false, message: "", error: error instanceof Error ? error.message : "Could not save your username." }); }
  };
  return <form className="card profile-card" onSubmit={submit}>
    <div className="profile-card-head"><h2>Your username</h2><button className="button primary" disabled={state.busy || !value.trim() || value.trim() === saved}>{state.busy ? "Saving…" : "Save username"}</button></div>
    <div className="profile-fields"><label>Your page address<span className="username-field"><span aria-hidden="true">callerwhale.com/</span><input value={value} onChange={event => setValue(event.target.value.toLowerCase())} maxLength={30} autoComplete="username" spellCheck={false} aria-describedby="username-help" /></span></label></div>
    <p id="username-help" className="muted">3 to 30 letters, numbers or hyphens. Only you can open this page.</p>
    {state.message && <p role="status" className="notice good">{state.message}</p>}{state.error && <p role="alert" className="notice bad">{state.error}</p>}
  </form>;
}

export function Profile({ me, auth, authBase, onSaved }: { me: Me; auth: Auth; authBase: string; onSaved: () => void }) {
  const [parts, setParts] = useState(() => namePartsOf(me));
  const name = [parts.first, parts.middle, parts.last].filter(Boolean).join(" ");
  const [phone, setPhone] = useState(String(me.phone || ""));
  const savedAvatar = String(me.avatar || "");
  const [cropping, setCropping] = useState<File | null>(null);
  const [pictureState, setPictureState] = useState({ busy: false, message: "", error: "" });
  const avatar = savedAvatar;
  const [access, setAccess] = useState<Access | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [available, setAvailable] = useState<{ google?: boolean; apple?: boolean }>({});
  const [state, setState] = useState({ busy: false, message: "", error: "" });
  useEffect(() => { setParts(namePartsOf(me)); setPhone(String(me.phone || "")); }, [me.id, me.name, me.phone, me.first_name, me.middle_name, me.last_name]);
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
  const post = async (body: { name: string; phone: string; avatar: string; first_name?: string; middle_name?: string; last_name?: string }) => {
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
      await post({ name, phone: phone.trim(), avatar: savedAvatar, first_name: parts.first, middle_name: parts.middle, last_name: parts.last });
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
    <header className="page-head profile-head"><button type="button" className="profile-avatar profile-avatar-button" aria-label="Change profile picture" title="Change profile picture" onClick={() => pictureInput.current?.click()}>{avatar ? <img src={avatar} alt="" /> : (name || me.email).charAt(0).toUpperCase()}<span className="profile-avatar-change" aria-hidden="true">Change</span></button><input ref={pictureInput} type="file" hidden accept="image/*" onChange={picture} /><div><h1>{me.name || "Your profile"}</h1>{access && <RoleBadges access={access} />}<div className="profile-picture-actions"><button type="button" className="button raised" disabled={pictureState.busy} onClick={() => pictureInput.current?.click()}>{savedAvatar ? "Change picture" : "Choose picture"}</button>{savedAvatar && <button type="button" className="text-button" disabled={pictureState.busy} onClick={() => void savePicture("")}>Remove</button>}</div>{pictureState.message && <p role="status" className="notice good">{pictureState.message}</p>}{pictureState.error && <p role="alert" className="notice bad">{pictureState.error}</p>}</div></header>
    {cropping && <AvatarCropper file={cropping} onCancel={() => setCropping(null)} onDone={savePicture} />}
    <div className="profile-grid"><form className="card profile-card" onSubmit={save}><div className="profile-card-head"><h2>Personal details</h2><button className="button primary" disabled={state.busy || !parts.first.trim()} aria-busy={state.busy}>{state.busy ? <><span className="spinner" aria-hidden="true" />Saving…</> : "Save changes"}</button></div><div className="profile-fields"><div className="profile-name"><label>First name<input required maxLength={60} autoComplete="given-name" value={parts.first} onChange={event => setParts({ ...parts, first: event.target.value })} /></label><label>Middle name<input maxLength={60} autoComplete="additional-name" value={parts.middle} onChange={event => setParts({ ...parts, middle: event.target.value })} placeholder="Optional" /></label><label>Last name<input maxLength={60} autoComplete="family-name" value={parts.last} onChange={event => setParts({ ...parts, last: event.target.value })} placeholder="Optional" /></label></div><label>Email<input value={me.email} readOnly aria-readonly="true" /></label><label>Phone number<input type="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="Optional" autoComplete="tel" /></label></div>{state.message && <p role="status" className="notice good">{state.message}</p>}{state.error && <p role="alert" className="notice bad">{state.error}</p>}</form>
      <UsernameCard me={me} auth={auth} authBase={authBase} onSaved={onSaved} />
      <section className="card profile-card"><h2>Connected accounts</h2><div className="profile-providers">{(["google", "apple"] as const).map(provider => <div key={provider}><span>{provider === "google" ? "Google" : "Apple"}</span>{providers.includes(provider) ? <span className="role-badge">Connected</span> : available[provider] ? <button type="button" className="button" disabled={state.busy} onClick={() => void link(provider)}>Connect</button> : <span className="muted">Unavailable</span>}</div>)}</div>{linked && <p role="status" className="notice good">{linked === "apple" ? "Apple" : "Google"} connected.</p>}{linkError && <p role="alert" className="notice bad">{linkError}</p>}</section>
      <MainCurrency auth={auth} authBase={authBase} saved={String(me.currency || "")} onSaved={onSaved} /></div>
  </div>;
}
