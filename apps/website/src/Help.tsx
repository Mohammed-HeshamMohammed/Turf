// Help and feedback (D292-D295). The help pages, the support conversation for owners and admins, "What's new",
// early features, the "Send feedback" button, and staff's side of each.
import { useCallback, useEffect, useState } from "react";
import type { Auth } from "@callerwhale/auth-client";
import { Link } from "./nav.tsx";
import { helpArticles, searchHelp } from "./content/help.ts";

const appVersion = String(import.meta.env.VITE_APP_VERSION || "web");

function useAuthRequest(auth: Auth, authBase: string) {
  return useCallback(async (path: string, method = "GET", body?: unknown) => {
    const token = await auth.accessToken();
    if (!token) throw new Error("Sign in again.");
    const response = await fetch(`${authBase}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || "That did not work. Try again in a moment."), { code: result.code });
    return result;
  }, [auth, authBase]);
}

const when = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** /help: every article, filtered as the person types. */
export function HelpPage() {
  const [query, setQuery] = useState("");
  const found = searchHelp(query);
  return <main className="page legal-page">
    <h1>Help</h1>
    <p className="muted">Short answers to common questions. In the app, the assistant answers the rest; owners and admins can also write to us from the dashboard.</p>
    <label className="help-search">Search help<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Try: import, texting, files" /></label>
    {found.length === 0 ? <p className="muted" role="status">Nothing matches. Ask the assistant in the app, or <Link to="/contact">contact us</Link>.</p> : found.map(article => <section key={article.slug} id={article.slug} className="card">
      <span className="eyebrow">{article.topic}</span>
      <h2>{article.title}</h2>
      {article.body.map(line => <p key={line}>{line}</p>)}
    </section>)}
    <p className="muted">{helpArticles.length} articles.</p>
  </main>;
}

/** "Send feedback": the note, the page's path and the app version. Nothing from the page's content is sent (D295). */
export function FeedbackButton({ auth, authBase, orgId }: { auth: Auth; authBase: string; orgId?: string }) {
  const request = useAuthRequest(auth, authBase);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const send = async () => {
    try {
      await request("/v1/feedback", "POST", { note, page: window.location.pathname, version: appVersion, org_id: orgId });
      setNote(""); setMessage("Thank you: we read every note."); setOpen(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : "That did not send."); }
  };
  return <div className="feedback-button">
    {open ? <div className="card feedback-form" role="dialog" aria-label="Send feedback">
      <label>What should we improve?<textarea value={note} maxLength={3000} rows={4} onChange={event => setNote(event.target.value)} /></label>
      <p className="muted">We get this page's address and the app version, never your leads.</p>
      <button type="button" className="button" disabled={note.trim().length < 3} onClick={() => void send()}>Send</button>{" "}
      <button type="button" className="staff-text-button" onClick={() => setOpen(false)}>Cancel</button>
    </div> : <button type="button" className="button" onClick={() => { setOpen(true); setMessage(""); }}>Send feedback</button>}
    {message && <p className="notice" role="status">{message}</p>}
  </div>;
}

type Note = { id: string; title: string; body: string; kind: string; published_at: string };

/** The "What's new" notes for this person in the agency that they have not seen; each goes once read (D293). */
export function WhatsNew({ auth, authBase, orgId }: { auth: Auth; authBase: string; orgId: string }) {
  const request = useAuthRequest(auth, authBase);
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => { request(`/v1/whats-new?org=${orgId}`).then(result => setNotes(result.notes || []), () => setNotes([])); }, [request, orgId]);
  if (!notes.length) return null;
  const seen = (id: string) => { void request(`/v1/whats-new/${id}/seen`, "POST").catch(() => undefined); setNotes(list => list.filter(note => note.id !== id)); };
  return <section className="card" aria-labelledby={`whats-new-${orgId}`}>
    <span className="eyebrow">What's new</span>
    <h2 id={`whats-new-${orgId}`}>{notes.length === 1 ? notes[0].title : `${notes.length} new things`}</h2>
    {notes.map(note => <div key={note.id} className="whats-new-note">
      {notes.length > 1 && <h3>{note.title}</h3>}
      <p>{note.body}</p>
      <button type="button" className="staff-text-button" onClick={() => seen(note.id)}>Got it</button>
    </div>)}
  </section>;
}

type Feature = { name: string; title: string; description: string; on: boolean };

/** Early features the owner switches on for the agency (D294). */
export function EarlyFeatures({ auth, authBase, orgId, owner }: { auth: Auth; authBase: string; orgId: string; owner: boolean }) {
  const request = useAuthRequest(auth, authBase);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [message, setMessage] = useState("");
  useEffect(() => { request(`/v1/orgs/${orgId}/early-features`).then(result => setFeatures(result.features || []), () => setFeatures([])); }, [request, orgId]);
  const toggle = async (feature: Feature) => {
    try { const result = await request(`/v1/orgs/${orgId}/early-features/${feature.name}`, "PUT", { on: !feature.on }); setFeatures(result.features || []); setMessage(""); }
    catch (error) { setMessage((error as { code?: string }).code === "mfa_required" ? "Sign in with two-step sign-in first." : error instanceof Error ? error.message : "That did not work."); }
  };
  if (!features.length) return null;
  return <section className="card" aria-labelledby={`early-${orgId}`}>
    <h2 id={`early-${orgId}`}>Early features</h2>
    <p className="muted">Try what is coming before everyone else. These may still change.</p>
    <ul className="membership-list">{features.map(feature => <li key={feature.name}>
      <strong>{feature.title}</strong> <span className="muted">{feature.description}</span>{" "}
      {owner ? <button type="button" className="button" onClick={() => void toggle(feature)}>{feature.on ? "Switch off" : "Switch on"}</button> : <span className="muted">{feature.on ? "On" : "Off"}</span>}
    </li>)}</ul>
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}

type Chat = { id: string; subject: string; status: string; waiting_on: string; updated_at: string; org_id?: string };
type Message = { id: string; from_staff: boolean; author: string; body: string; created_at: string };

function Conversation({ request, id, onBack }: { request: ReturnType<typeof useAuthRequest>; id: string; onBack: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => request(`/v1/support-chats/${id}`).then(result => { setMessages(result.messages || []); setStatus(result.status); }, failure => setError(failure.message)), [request, id]);
  useEffect(() => { void load(); }, [load]);
  const send = async () => {
    try { await request(`/v1/support-chats/${id}/messages`, "POST", { body: reply }); setReply(""); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "That did not send."); }
  };
  const close = async () => { await request(`/v1/support-chats/${id}/close`, "POST").catch(() => undefined); onBack(); };
  return <div>
    <button type="button" className="staff-text-button" onClick={onBack}>← All conversations</button>
    <ol className="support-messages">{messages.map(message => <li key={message.id} className={message.from_staff ? "from-staff" : "from-agency"}>
      <strong>{message.author || "You"}</strong> <span className="muted">{when(message.created_at)}</span><p>{message.body}</p>
    </li>)}</ol>
    <label>Reply<textarea value={reply} rows={3} maxLength={5000} onChange={event => setReply(event.target.value)} /></label>
    <button type="button" className="button" disabled={!reply.trim()} onClick={() => void send()}>Send</button>{" "}
    {status === "open" && <button type="button" className="staff-text-button" onClick={() => void close()}>Close conversation</button>}
    {error && <p className="notice" role="alert">{error}</p>}
  </div>;
}

/** The agency's support conversations with Caller Whale, for its owner and admins (D292). */
export function SupportChats({ auth, authBase, orgId }: { auth: Auth; authBase: string; orgId: string }) {
  const request = useAuthRequest(auth, authBase);
  const [chats, setChats] = useState<Chat[]>([]);
  const [openId, setOpenId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(() => request(`/v1/orgs/${orgId}/support-chats`).then(result => setChats(result.chats || []), failure => setMessage(failure.message)), [request, orgId]);
  useEffect(() => { void load(); }, [load]);
  const start = async () => {
    try { const result = await request(`/v1/orgs/${orgId}/support-chats`, "POST", { subject, body }); setSubject(""); setBody(""); setOpenId(result.id); }
    catch (failure) { setMessage(failure instanceof Error ? failure.message : "That did not send."); }
  };
  return <section className="card" aria-labelledby={`support-chats-${orgId}`}>
    <h2 id={`support-chats-${orgId}`}>Support</h2>
    {openId ? <Conversation request={request} id={openId} onBack={() => { setOpenId(""); void load(); }} /> : <>
      <p className="muted">Write to Caller Whale. We answer here and by email. Many answers are already in <Link to="/help">Help</Link>.</p>
      <div className="staff-fields">
        <label>Subject<input value={subject} maxLength={150} onChange={event => setSubject(event.target.value)} /></label>
        <label>Message<textarea value={body} rows={4} maxLength={5000} onChange={event => setBody(event.target.value)} /></label>
        <button type="button" className="button" disabled={subject.trim().length < 3 || !body.trim()} onClick={() => void start()}>Send to support</button>
      </div>
      {chats.length > 0 && <ul className="membership-list">{chats.map(chat => <li key={chat.id}>
        <button type="button" className="staff-text-button" onClick={() => setOpenId(chat.id)}>{chat.subject}</button>{" "}
        <span className="muted">{chat.status === "closed" ? "Closed" : chat.waiting_on === "agency" ? "Answered" : "Waiting for us"} · {when(chat.updated_at)}</span>
      </li>)}</ul>}
    </>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}

/** Staff: support conversations, What's new notes and feedback (D292, D293, D295). */
export function StaffHelp({ auth, authBase }: { auth: Auth; authBase: string }) {
  const request = useAuthRequest(auth, authBase);
  const [chats, setChats] = useState<Chat[]>([]);
  const [openId, setOpenId] = useState("");
  const [notes, setNotes] = useState<(Note & { roles: string[]; feature: string; seen_by: number })[]>([]);
  const [feedback, setFeedback] = useState<{ id: string; from: string; page: string; version: string; note: string; created_at: string }[]>([]);
  const [draft, setDraft] = useState({ title: "", body: "", roles: "", feature: "", kind: "feature" });
  const [message, setMessage] = useState("");
  const load = useCallback(() => {
    request("/v1/admin/support-chats").then(result => setChats(result.chats || []), () => setChats([]));
    request("/v1/admin/whats-new").then(result => setNotes(result.notes || []), () => setNotes([]));
    request("/v1/admin/feedback").then(result => setFeedback(result.feedback || []), () => setFeedback([]));
  }, [request]);
  useEffect(() => { load(); }, [load]);
  const publish = async () => {
    try {
      await request("/v1/admin/whats-new", "POST", { ...draft, roles: draft.roles.split(",").map(role => role.trim()).filter(Boolean) });
      setDraft({ title: "", body: "", roles: "", feature: "", kind: "feature" }); setMessage("Published."); load();
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : "That did not work."); }
  };
  return <div className="dashboard-page">
    <section className="card" aria-labelledby="staff-support"><h2 id="staff-support">Support conversations</h2>
      {openId ? <Conversation request={request} id={openId} onBack={() => { setOpenId(""); load(); }} /> : chats.length === 0 ? <p className="muted">None open.</p> : <ul className="membership-list">{chats.map(chat => <li key={chat.id}>
        <button type="button" className="staff-text-button" onClick={() => setOpenId(chat.id)}>{chat.subject}</button> <span className="muted">{chat.waiting_on === "staff" ? "Waiting for us" : "Answered"} · {when(chat.updated_at)}</span>
      </li>)}</ul>}
    </section>
    <section className="card" aria-labelledby="staff-whats-new"><h2 id="staff-whats-new">What's new</h2>
      <div className="staff-fields">
        <label>Title<input value={draft.title} maxLength={120} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>Note<textarea value={draft.body} rows={3} maxLength={4000} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
        <label>Roles (comma-separated; empty: everyone)<input value={draft.roles} onChange={event => setDraft({ ...draft, roles: event.target.value })} placeholder="caller, closer" /></label>
        <label>Switch (only where it is on)<input value={draft.feature} onChange={event => setDraft({ ...draft, feature: event.target.value })} placeholder="teams_v2" /></label>
        <label>Kind<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value })}><option value="feature">Feature</option><option value="fix">Fix</option><option value="terms">Terms or privacy</option></select></label>
        <button type="button" className="button" onClick={() => void publish()}>Publish</button>
      </div>
      <ul className="membership-list">{notes.map(note => <li key={note.id}><strong>{note.title}</strong> <span className="muted">{note.roles.length ? note.roles.join(", ") : "everyone"}{note.feature ? ` · ${note.feature}` : ""} · seen by {note.seen_by}</span></li>)}</ul>
      {message && <p className="notice" role="status">{message}</p>}
    </section>
    <section className="card" aria-labelledby="staff-feedback"><h2 id="staff-feedback">Feedback</h2>
      {feedback.length === 0 ? <p className="muted">Nothing new.</p> : <ul className="membership-list">{feedback.map(item => <li key={item.id}>
        <p>{item.note}</p><span className="muted">{item.from} · {item.page || "—"} · {item.version} · {when(item.created_at)}</span>{" "}
        <button type="button" className="staff-text-button" onClick={() => void request(`/v1/admin/feedback/${item.id}/handled`, "POST").then(load)}>Handled</button>
      </li>)}</ul>}
    </section>
  </div>;
}
