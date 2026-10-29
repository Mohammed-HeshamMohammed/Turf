import { useEffect, useRef, useState } from "react";
import { ArrowBendUpLeft, ArrowBendUpRight, CaretDown, Paperclip, PaperPlaneTilt, Trash } from "@phosphor-icons/react";
import { Avatar } from "./ui.jsx";

// Email threads read like email, not chat: a subject, one card per message with who sent it to whom and when, older
// messages folded to one line, and Reply or Forward opening a compose card with To, Cc and Subject. Every address and
// field is checked again in model.js (emailFields) when the message is saved.

/** The workspace's own address for a teammate (sample workspaces have no real mail domain). */
export const teamAddress = name => name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "") + "@oakpalm.example";
const plain = subject => String(subject || "").replace(/^(re|fwd?):\s*/i, "");
/** The thread's subject without "Re:" or "Fwd:" in front. */
export const subjectOf = thread =>
  // The thread's own subject, else the first one written on a reply, else the list preview of an older thread.
  plain(thread.subject || thread.messages.find(message => message.email?.subject)?.email.subject || thread.preview || "No subject");

function Initials({ name }) {
  const letters = name
    .split(/\s+/)
    .map(part => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="email-initials" aria-hidden="true">
      {letters}
    </span>
  );
}

function MailCard({ message, open, onToggle, lead, me, last, onReply, onForward }) {
  const fromName = message.incoming ? lead?.name || message.from : message.from;
  const fromAddress = message.incoming ? lead?.email : teamAddress(message.from);
  const to = message.email?.to || [message.incoming ? teamAddress(me) : lead?.email].filter(Boolean);
  const cc = message.email?.cc || [];
  return (
    <article className={"email-card" + (open ? " open" : "")}>
      <button type="button" className="email-card-head" aria-expanded={open} onClick={onToggle}>
        {message.incoming ? <Initials name={fromName} /> : <Avatar name={message.from} small />}
        <span className="email-who">
          <strong>{fromName}</strong>
          {open ? (
            <small>
              {fromAddress && <span>{fromAddress}</span>}
              <span>to {to.join(", ")}</span>
              {cc.length > 0 && <span>cc {cc.join(", ")}</span>}
            </small>
          ) : (
            <small className="email-snippet">{message.text}</small>
          )}
        </span>
        <time>{message.at}</time>
        <CaretDown size={14} className="email-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="email-body">
          {message.text.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
          {message.kind === "file" || message.kind === "photo" ? (
            <span className="email-attachment">
              <Paperclip size={15} /> {message.file.name}
            </span>
          ) : null}
          {message.draft && <small className="email-draft">Not sent · saved as a draft</small>}
          {last && (
            <div className="email-actions">
              <button type="button" className="button" onClick={onReply}>
                <ArrowBendUpLeft size={16} /> Reply
              </button>
              <button type="button" className="button" onClick={onForward}>
                <ArrowBendUpRight size={16} /> Forward
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** One email thread: the subject, the messages (the latest open), and a compose card for a reply or forward. */
export function EmailThread({ thread, lead, me, canMessage, online, onSend }) {
  const last = thread.messages.length - 1;
  const [open, setOpen] = useState(() => new Set([last]));
  const [compose, setCompose] = useState(null);
  const body = useRef(null);
  const subject = subjectOf(thread);
  useEffect(() => {
    setOpen(new Set([thread.messages.length - 1]));
    setCompose(null);
  }, [thread.id, thread.messages.length]);
  const mode = compose?.mode;
  useEffect(() => {
    if (mode) body.current?.focus();
  }, [mode]);
  const start = mode => {
    const original = thread.messages[last];
    setCompose({
      mode,
      to: mode === "reply" ? lead?.email || "" : "",
      cc: "",
      subject: (mode === "reply" ? "Re: " : "Fwd: ") + subject,
      text:
        mode === "forward" && original
          ? `\n\n---------- Forwarded message ----------\nFrom: ${original.incoming ? lead?.name || original.from : original.from}\nDate: ${original.at}\nSubject: ${subject}\n\n${original.text}`
          : "",
    });
  };
  const set = key => event => setCompose({ ...compose, [key]: event.target.value });
  const send = () => {
    if (!compose.text.trim() || !compose.to.trim()) return;
    onSend({ text: compose.text, email: { to: compose.to, cc: compose.cc, subject: compose.subject } });
    setCompose(null);
  };
  return (
    <div className="email-thread">
      <h3 className="email-subject">{subject}</h3>
      <div className="email-list">
        {thread.messages.map((message, index) => (
          <MailCard
            key={index}
            message={message}
            lead={lead}
            me={me}
            open={open.has(index)}
            last={index === last && canMessage && !compose}
            onToggle={() => {
              const next = new Set(open);
              next.has(index) ? next.delete(index) : next.add(index);
              setOpen(next);
            }}
            onReply={() => start("reply")}
            onForward={() => start("forward")}
          />
        ))}
        {!thread.messages.length && canMessage && !compose && (
          <div className="email-actions">
            <button type="button" className="button primary" onClick={() => start("reply")}>
              Write an email
            </button>
          </div>
        )}
      </div>
      {compose && (
        <form
          className="email-compose"
          onSubmit={event => {
            event.preventDefault();
            send();
          }}
        >
          <label>
            <span>To</span>
            <input type="text" inputMode="email" value={compose.to} onChange={set("to")} placeholder="name@example.com" required />
          </label>
          <label>
            <span>Cc</span>
            <input type="text" inputMode="email" value={compose.cc} onChange={set("cc")} placeholder="Optional, separate with commas" />
          </label>
          <label>
            <span>Subject</span>
            <input type="text" value={compose.subject} maxLength={200} onChange={set("subject")} />
          </label>
          <textarea
            ref={body}
            aria-label="Email text"
            value={compose.text}
            onChange={set("text")}
            onKeyDown={event => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={compose.mode === "reply" ? "Write your reply…" : "Add a note above the forwarded message…"}
          />
          <div className="email-compose-actions">
            <button type="submit" className="button primary" disabled={!compose.text.trim() || !compose.to.trim()}>
              <PaperPlaneTilt size={16} /> {online ? "Send demo email" : "Save draft"}
            </button>
            <small>Ctrl + Enter to send</small>
            <button type="button" className="email-discard" aria-label="Discard" title="Discard" onClick={() => setCompose(null)}>
              <Trash size={17} />
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
