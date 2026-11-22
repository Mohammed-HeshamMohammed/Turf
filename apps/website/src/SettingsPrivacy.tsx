import { useEffect, useState, type FormEvent } from "react";
import type { Auth, Me } from "@callerwhale/auth-client";

const problem = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

type Choice = { value: string; label: string };
const PHONE: Choice[] = [
  { value: "nobody", label: "Nobody" },
  { value: "leads", label: "My agencies' owners, admins and team leads" },
  { value: "agencies", label: "Everyone in my agencies" },
];
const FIND: Choice[] = [
  { value: "exact", label: "People in my agencies by name; anyone else only with my exact name and tag" },
  { value: "agencies", label: "Only people in my agencies" },
];
const MESSAGE: Choice[] = [
  { value: "requests", label: "Anyone who finds me, with a request I accept first" },
  { value: "agencies", label: "Only people in my agencies" },
  { value: "nobody", label: "Nobody" },
];

/** Settings, Privacy: the #tag after the person's name, and who can see their phone, find them and message them. */
export function SettingsPrivacy({ me, auth, authBase, onSaved }: { me: Me; auth: Auth; authBase: string; onSaved: () => void }) {
  const savedTag = String(me.tag || "");
  const [tag, setTag] = useState(savedTag);
  const [tagState, setTagState] = useState({ busy: false, message: "", error: "" });
  const [settings, setSettings] = useState({ phone_visible: String(me.phone_visible || "nobody"), find_me: String(me.find_me || "exact"), message_me: String(me.message_me || "requests") });
  const [state, setState] = useState({ busy: false, message: "", error: "" });
  useEffect(() => setTag(savedTag), [savedTag]);
  useEffect(() => setSettings({ phone_visible: String(me.phone_visible || "nobody"), find_me: String(me.find_me || "exact"), message_me: String(me.message_me || "requests") }), [me.phone_visible, me.find_me, me.message_me]);

  const send = async (path: string, method: string, body?: unknown) => {
    const token = await auth.accessToken();
    if (!token) throw new Error("Sign in again to save this.");
    const response = await fetch(`${authBase}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "That could not be saved.");
    return result;
  };
  const saveTag = async (event: FormEvent) => {
    event.preventDefault();
    setTagState({ busy: true, message: "", error: "" });
    try { await send("/v1/me/tag", "POST", { tag: tag.trim() }); setTagState({ busy: false, message: "Tag saved.", error: "" }); onSaved(); }
    catch (error) { setTagState({ busy: false, message: "", error: problem(error, "Your tag could not be saved.") }); }
  };
  const dismissNote = async () => { try { await send("/v1/me/tag-note", "POST"); onSaved(); } catch { /* the note simply stays */ } };
  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    setState({ busy: true, message: "", error: "" });
    try { await send("/v1/me/privacy", "PUT", settings); setState({ busy: false, message: "Saved.", error: "" }); onSaved(); }
    catch (error) { setState({ busy: false, message: "", error: problem(error, "Your settings could not be saved.") }); }
  };
  const pick = (name: keyof typeof settings, label: string, choices: Choice[]) => (
    <label>{label}<select value={settings[name]} onChange={event => setSettings({ ...settings, [name]: event.target.value })}>
      {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
    </select></label>
  );

  return (
    <div className="settings-stack">
      {me.tag_note === true && (
        <section className="card profile-card" aria-labelledby="tag-note-title">
          <div className="profile-card-head"><h2 id="tag-note-title">You have a tag</h2><button type="button" className="button" onClick={dismissNote}>Got it</button></div>
          <p className="muted">Your full name is now <strong>{me.name}#{savedTag}</strong>. People still see just your name; the tag appears only where two people have the same name. You can change it below.</p>
        </section>
      )}
      <form className="card profile-card" onSubmit={saveTag} aria-labelledby="tag-title">
        <div className="profile-card-head"><h2 id="tag-title">Your tag</h2><button className="button primary" disabled={tagState.busy || !tag.trim() || tag.trim().toUpperCase() === savedTag}>{tagState.busy ? "Saving…" : "Save tag"}</button></div>
        <p className="muted">Your full name is <strong>{me.name}#{savedTag}</strong>. Someone outside your agencies can find you only with it.</p>
        <div className="profile-fields"><label>Tag<input value={tag} onChange={event => setTag(event.target.value.toUpperCase().replace(/^#/, ""))} maxLength={8} spellCheck={false} autoComplete="off" aria-describedby="tag-help" /></label></div>
        <p id="tag-help" className="muted">3 to 8 letters and digits. 0, O, 1 and I are left out because they look alike. Your name and your tag can each be changed twice in 30 days, and a full name you stop using stays yours for 90 days.</p>
        {tagState.message && <p role="status" className="notice good">{tagState.message}</p>}{tagState.error && <p role="alert" className="notice bad">{tagState.error}</p>}
      </form>
      <form className="card profile-card" onSubmit={saveSettings} aria-labelledby="privacy-title">
        <div className="profile-card-head"><h2 id="privacy-title">Who can see and reach me</h2><button className="button primary" disabled={state.busy}>{state.busy ? "Saving…" : "Save"}</button></div>
        <div className="profile-fields">
          {pick("phone_visible", "Who can see my phone number", PHONE)}
          {pick("find_me", "Who can find me", FIND)}
          {pick("message_me", "Who can message me outside an agency", MESSAGE)}
        </div>
        <p className="muted">Everyone in an agency always sees who else is in it. These settings are about everyone else, and about your phone number.</p>
        {state.message && <p role="status" className="notice good">{state.message}</p>}{state.error && <p role="alert" className="notice bad">{state.error}</p>}
      </form>
    </div>
  );
}
