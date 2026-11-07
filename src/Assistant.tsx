import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "./nav.tsx";
import { ask, greeting, loadTurns, markSeen, MAX_CHARS, nudgeFor, saveTurns, seen, type Turn } from "./assistant-client.ts";

// The helper chat: a round button at the bottom right that opens a small chat. Visitors who are not signed in get a short hello above
// the button; on the pages where people choose a plan, a suggestion opens by itself, once. The conversation stays in this tab.

function Hint({ children, onClose, onOpen }: { children: React.ReactNode; onClose: () => void; onOpen: () => void }) {
  return (
    <div className="assistant-hint" role="status">
      <button type="button" className="assistant-hint-text" onClick={onOpen}>{children}</button>
      <button type="button" className="assistant-hint-close" aria-label="Dismiss" onClick={onClose}>×</button>
    </div>
  );
}

export function Assistant({ signedIn, path }: { signedIn: boolean | undefined; path: string }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState<"hello" | { text: string; ask: string } | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    setTurns(loadTurns());
  }, []);
  useEffect(() => {
    if (turns.length) saveTurns(turns);
  }, [turns]);

  // The hello above the button (signed-out visitors, once per visit), and the plan suggestion that opens by itself (once per page kind).
  useEffect(() => {
    if (open || signedIn === undefined) return;
    const started = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (!signedIn && !seen("hello")) timers.push(setTimeout(() => (setHint(h => h ?? "hello"), markSeen("hello")), 4000));
    for (const seconds of [12, 25, 30]) {
      timers.push(setTimeout(() => {
        const nudge = nudgeFor(path, (Date.now() - started) / 1000);
        if (nudge && !seen("nudge-" + path)) (setHint(nudge), markSeen("nudge-" + path));
      }, seconds * 1000 + 50));
    }
    return () => timers.forEach(clearTimeout);
  }, [path, signedIn, open]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [turns, busy, open]);
  useEffect(() => {
    if (open) field.current?.focus();
    else if (wasOpen.current) button.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [open]);

  const shown = [greeting, ...turns];

  const send = async (content: string) => {
    const message = content.trim();
    if (!message || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: message.slice(0, MAX_CHARS) }];
    setTurns(next);
    setText("");
    setError("");
    setBusy(true);
    try {
      const reply = await ask(next, path);
      setTurns(current => [...current, reply]);
    } catch (reason) {
      setError((reason as Error).message || "The assistant is not available right now.");
    } finally {
      setBusy(false);
    }
  };

  const openWith = (question?: string) => {
    setHint(null);
    setOpen(true);
    if (question) void send(question);
  };

  const last = shown[shown.length - 1];
  return (
    <div className="assistant">
      {open && (
        <section className="assistant-panel" role="dialog" aria-label="Caller Whale assistant">
          <header>
            <div>
              <strong>Caller Whale assistant</strong>
              <small>Automated · it can be wrong</small>
            </div>
            <button type="button" className="assistant-close" aria-label="Close the assistant" onClick={() => setOpen(false)}>×</button>
          </header>
          <div className="assistant-log" ref={log} role="log" aria-live="polite">
            {shown.map((turn, i) => (
              <div key={i} className={`bubble ${turn.role === "user" ? "me" : "bot"}`}>
                {turn.content}
                {turn.link && <Link className="button primary assistant-link" to={turn.link.to} onClick={() => setOpen(false)}>{turn.link.label}</Link>}
              </div>
            ))}
            {busy && <div className="bubble bot typing" role="status" aria-label="The assistant is typing"><span /><span /><span /></div>}
            {error && <p className="notice bad" role="alert">{error} <Link to="/contact" onClick={() => setOpen(false)}>Contact the team</Link></p>}
          </div>
          {!busy && last.role === "assistant" && last.suggestions && last.suggestions.length > 0 && (
            <div className="assistant-chips" role="group" aria-label="Suggestions">
              {last.suggestions.map(s => <button key={s} type="button" className="button raised" onClick={() => void send(s)}>{s}</button>)}
            </div>
          )}
          <form className="assistant-form" onSubmit={(e: FormEvent) => (e.preventDefault(), void send(text))}>
            <input ref={field} value={text} maxLength={MAX_CHARS} placeholder="Ask about plans, importing, calls…" aria-label="Your message" onChange={e => setText(e.target.value)} />
            <button className="button primary" type="submit" disabled={busy || !text.trim()}>Send</button>
          </form>
          <p className="assistant-note">Please do not type passwords or card numbers.</p>
        </section>
      )}
      {!open && hint && (
        <Hint onClose={() => setHint(null)} onOpen={() => openWith(hint === "hello" ? undefined : hint.ask)}>
          {hint === "hello" ? "Need help? I'm the Caller Whale assistant. Ask me anything." : hint.text}
        </Hint>
      )}
      <button ref={button} type="button" className="assistant-button" aria-label={open ? "Close the assistant" : "Open the assistant chat"} aria-expanded={open} onClick={() => (open ? setOpen(false) : openWith())}>
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /></svg>
      </button>
    </div>
  );
}
