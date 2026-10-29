import { useEffect, useRef, useState } from "react";
import { ArrowBendUpLeft, ChartBar, FileText, Image, MapPin, Plus, Smiley, UserCircle, X } from "@phosphor-icons/react";
import { PEOPLE } from "./data.js";
import { REACTIONS, messagePreview } from "./model.js";
import { Empty, Field, Modal } from "./ui.jsx";

// The Inbox's chat tools: the + menu (photo, file, location, contact, poll), the emoji and GIF panel, and how each kind
// of message is shown, with replies, reactions, poll votes and @mentions. What a message may carry is checked in
// model.js (attachmentFor); this file only builds and shows it.

const GIPHY_KEY = import.meta.env?.VITE_GIPHY_API_KEY || "";
const EMOJI = [
  ["Smileys", "😀 😃 😄 😁 😆 😅 😂 🙂 😉 😊 😍 😘 😎 🤔 😐 😴 😮 😢 😭 😡 🤯 🥳"],
  ["Gestures", "👍 👎 👌 👏 🙌 🙏 💪 🤝 👋 ✌️ 🤞 👀"],
  ["Work", "🏠 🏡 🔑 📞 📱 💬 📧 📅 ⏰ 📍 📝 📄 💰 💵 📈 ✅ ❌ ⚠️ 🔥 ⭐ 🎉 ❤️"],
].map(([name, list]) => [name, list.split(" ")]);
const PHOTO_LIMIT = 500 * 1024;

/** Opens on click, closes on a click outside or Escape, and gives focus back to its button. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => !root.current?.contains(event.target) && setOpen(false);
    const escape = event => {
      if (event.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector("[aria-expanded]")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return { open, setOpen, root };
}

const size = bytes => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB");

/** The + button: what can go into a conversation besides text, Telegram-style. */
export function AttachMenu({ thread, lead, leads, onAttach, onPoll }) {
  const { open, setOpen, root } = usePopover();
  const [picking, setPicking] = useState(false);
  const photoInput = useRef(null);
  const fileInput = useRef(null);
  const close = () => {
    setOpen(false);
    setPicking(false);
  };
  const send = (file, asPhoto) => {
    if (!file) return;
    const image = asPhoto && file.type.startsWith("image/");
    if (image && file.size <= PHOTO_LIMIT) {
      const reader = new FileReader();
      reader.onload = () => onAttach({ kind: "photo", file: { name: file.name, size: file.size, src: reader.result } });
      reader.readAsDataURL(file);
    } else onAttach({ kind: image ? "photo" : "file", file: { name: file.name, size: file.size } });
  };
  const items = [
    { label: "Photo or video", icon: Image, onClick: () => photoInput.current?.click() },
    { label: "File", icon: FileText, onClick: () => fileInput.current?.click() },
    lead && { label: "Location", icon: MapPin, onClick: () => onAttach({ kind: "location", location: { address: [lead.address, lead.city, lead.region].filter(Boolean).join(", ") } }) },
    { label: "Contact", icon: UserCircle, keep: true, onClick: () => setPicking(true) },
    ["Team", "Group"].includes(thread.channel) && { label: "Poll", icon: ChartBar, onClick: onPoll },
  ].filter(Boolean);
  return (
    <div className="chat-tool" ref={root}>
      <button type="button" className="chat-tool-button" aria-label="Attach" title="Attach" aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <Plus size={20} weight="bold" />
      </button>
      <input ref={photoInput} type="file" accept="image/*,video/*" hidden onChange={event => send(event.target.files?.[0], true)} />
      <input ref={fileInput} type="file" hidden onChange={event => send(event.target.files?.[0], false)} />
      {open && (
        <div className="chat-popover attach-menu" role="menu">
          {picking ? (
            <>
              <button type="button" role="menuitem" className="attach-back" onClick={() => setPicking(false)}>
                <ArrowBendUpLeft size={16} /> <span>Share a contact</span>
              </button>
              <div className="contact-pick">
                {leads.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onAttach({ kind: "contact", contact: { leadId: item.id, name: item.name, phone: item.phone } });
                      close();
                    }}
                  >
                    <strong>{item.name}</strong>
                    <small>{item.address}</small>
                  </button>
                ))}
              </div>
            </>
          ) : (
            items.map(item => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (!item.keep) setOpen(false);
                    item.onClick();
                  }}
                >
                  <span className="attach-icon">
                    <Icon size={18} />
                  </span>
                  <span>{item.label}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** Emoji and GIFs in one panel. GIFs come from GIPHY and need VITE_GIPHY_API_KEY and a connection. */
export function ExpressionPanel({ online, onEmoji, onGif }) {
  const { open, setOpen, root } = usePopover();
  const [tab, setTab] = useState("Emoji");
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState({ status: "idle", items: [], error: "" });
  useEffect(() => {
    if (!open || tab !== "GIFs" || !GIPHY_KEY || !online) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setGifs(current => ({ ...current, status: "loading", error: "" }));
      try {
        const q = query.trim();
        const url = `https://api.giphy.com/v1/gifs/${q ? "search" : "trending"}?api_key=${encodeURIComponent(GIPHY_KEY)}&limit=24&rating=g${q ? "&q=" + encodeURIComponent(q) : ""}`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 403 || response.status === 401 ? "GIPHY refused the key." : "GIPHY did not answer.");
        const { data } = await response.json();
        setGifs({
          status: "done",
          error: "",
          items: data.map(gif => ({ id: gif.id, title: gif.title, url: gif.images.fixed_height.url, preview: gif.images.fixed_height_small?.url || gif.images.fixed_height.url, width: gif.images.fixed_height.width, height: gif.images.fixed_height.height })),
        });
      } catch (error) {
        if (error.name !== "AbortError") setGifs({ status: "error", items: [], error: error.message || "GIPHY did not answer." });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, tab, query, online]);
  return (
    <div className="chat-tool" ref={root}>
      <button type="button" className="chat-tool-button" aria-label="Emoji and GIFs" title="Emoji and GIFs" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Smiley size={20} />
      </button>
      {open && (
        <div className="chat-popover expression-panel" role="dialog" aria-label="Emoji and GIFs">
          <div className="expression-tabs" role="tablist">
            {["Emoji", "GIFs"].map(name => (
              <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
                {name}
              </button>
            ))}
          </div>
          {tab === "Emoji" ? (
            <div className="emoji-groups">
              {EMOJI.map(([name, list]) => (
                <section key={name} aria-label={name}>
                  <small>{name}</small>
                  <div className="emoji-grid">
                    {list.map(emoji => (
                      <button key={emoji} type="button" aria-label={emoji} onClick={() => onEmoji(emoji)}>
                        {emoji}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : !GIPHY_KEY ? (
            <Empty title="GIFs are not set up">Add a GIPHY key as VITE_GIPHY_API_KEY in env/desktop.env and rebuild.</Empty>
          ) : !online ? (
            <Empty title="GIFs need a connection">They come back as soon as you are online.</Empty>
          ) : (
            <>
              <input className="gif-search" type="search" aria-label="Search GIFs" placeholder="Search GIPHY" value={query} onChange={event => setQuery(event.target.value)} />
              {gifs.status === "error" && <p className="gif-note">{gifs.error}</p>}
              <div className="gif-grid" aria-busy={gifs.status === "loading"}>
                {gifs.items.map(gif => (
                  <button
                    key={gif.id}
                    type="button"
                    aria-label={gif.title || "GIF"}
                    onClick={() => {
                      onGif(gif);
                      setOpen(false);
                    }}
                  >
                    <img src={gif.preview} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
              {gifs.status === "done" && !gifs.items.length && <p className="gif-note">No GIFs for that. Try another word.</p>}
              <small className="giphy-credit">Powered by GIPHY</small>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A poll for a team or group chat: a question and two to ten answers. */
export function PollDialog({ onSend, onClose }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const ready = question.trim() && options.filter(option => option.trim()).length >= 2;
  return (
    <Modal title="New poll" onClose={onClose}>
      <form
        className="poll-form"
        onSubmit={event => {
          event.preventDefault();
          if (!ready) return;
          onSend({ kind: "poll", poll: { question, options } });
          onClose();
        }}
      >
        <Field label="Question">
          <input value={question} maxLength={200} onChange={event => setQuestion(event.target.value)} placeholder="When should we call the Lewis lead?" required />
        </Field>
        {options.map((option, index) => (
          <Field key={index} label={"Answer " + (index + 1)}>
            <input value={option} maxLength={80} onChange={event => setOptions(options.map((item, i) => (i === index ? event.target.value : item)))} />
          </Field>
        ))}
        <div className="poll-form-actions">
          {options.length < 10 && (
            <button type="button" className="button" onClick={() => setOptions([...options, ""])}>
              Add an answer
            </button>
          )}
          <button type="submit" className="button primary" disabled={!ready}>
            Send poll
          </button>
        </div>
      </form>
    </Modal>
  );
}

const MENTION = new RegExp("(@(?:" + PEOPLE.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + "))", "g");

/** Message text with @mentions of teammates picked out. */
function Text({ text, me }) {
  if (!text) return null;
  return (
    <p>
      {text.split(MENTION).map((part, index) =>
        index % 2 ? (
          <span key={index} className={"mention" + (part === "@" + me ? " me" : "")}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

/** Teammates to mention while the draft ends with "@name". */
export function MentionPicker({ draft, onPick }) {
  const match = draft.match(/(?:^|\s)@([A-Za-z]*)$/);
  if (!match) return null;
  const found = PEOPLE.filter(name => name.toLowerCase().startsWith(match[1].toLowerCase()));
  if (!found.length) return null;
  return (
    <div className="mention-picker" role="listbox" aria-label="Mention a teammate">
      {found.map(name => (
        <button key={name} type="button" role="option" aria-selected="false" onClick={() => onPick(draft.slice(0, draft.length - match[1].length - 1) + "@" + name + " ")}>
          @{name}
        </button>
      ))}
    </div>
  );
}

/** One message: who, the reply it answers, what it carries, its reactions, and its reply and react actions. */
export function ChatMessage({ message, index, thread, me, canAct, onReply, onReact, onVote, onOpenLead, onJump }) {
  const [reacting, setReacting] = useState(false);
  const quoted = Number.isInteger(message.replyTo) ? thread.messages[message.replyTo] : null;
  const votes = message.kind === "poll" ? message.poll.options.reduce((sum, option) => sum + option.votes.length, 0) : 0;
  // Like any messenger: your own messages carry no name; others' do only where several people talk.
  const showName = message.incoming && ["Team", "Group", "Partner"].includes(thread.channel);
  return (
    <div id={"message-" + thread.id + "-" + index} className={"message " + (message.incoming ? "incoming" : "outgoing") + (message.kind ? " kind-" + message.kind : "")}>
      {showName && <small className="message-from">{message.from}</small>}
      {quoted && (
        <button type="button" className="message-quote" title="Show the message this answers" onClick={() => onJump(message.replyTo)}>
          <strong>{quoted.from}</strong>
          <span>{messagePreview(quoted)}</span>
        </button>
      )}
      {message.kind === "gif" && <img className="message-gif" src={message.gif.url} alt={message.gif.title} loading="lazy" width={message.gif.width || undefined} height={message.gif.height || undefined} />}
      {message.kind === "photo" && message.file.src && <img className="message-photo" src={message.file.src} alt={message.file.name} loading="lazy" />}
      {(message.kind === "file" || (message.kind === "photo" && !message.file.src)) && (
        <div className="message-card">
          {message.kind === "photo" ? <Image size={22} /> : <FileText size={22} />}
          <span>
            <strong>{message.file.name}</strong>
            <small>{message.file.size ? size(message.file.size) : "File"}</small>
          </span>
        </div>
      )}
      {message.kind === "location" && (
        <div className="message-card">
          <MapPin size={22} />
          <span>
            <strong>Location</strong>
            <small>{message.location.address}</small>
          </span>
        </div>
      )}
      {message.kind === "contact" && (
        <button type="button" className="message-card" onClick={() => message.contact.leadId && onOpenLead(message.contact.leadId)} disabled={!message.contact.leadId}>
          <UserCircle size={22} />
          <span>
            <strong>{message.contact.name}</strong>
            <small>{message.contact.phone || "Contact"}</small>
          </span>
        </button>
      )}
      {message.kind === "poll" && (
        <div className="message-poll">
          <strong>{message.poll.question}</strong>
          {message.poll.options.map((option, i) => {
            const share = votes ? Math.round((option.votes.length / votes) * 100) : 0;
            const mine = option.votes.includes(me);
            return (
              <button key={i} type="button" className={"poll-option" + (mine ? " mine" : "")} aria-pressed={mine} onClick={() => canAct && onVote(i)} disabled={!canAct}>
                <span className="poll-bar" style={{ width: share + "%" }} />
                <span>{option.text}</span>
                <small>{option.votes.length}</small>
              </button>
            );
          })}
          <small>
            {votes} {votes === 1 ? "vote" : "votes"}
          </small>
        </div>
      )}
      <Text text={message.text} me={me} />
      {message.reactions && Object.keys(message.reactions).length > 0 && (
        <div className="message-reactions">
          {Object.entries(message.reactions).map(([emoji, people]) => (
            <button key={emoji} type="button" className={people.includes(me) ? "mine" : ""} aria-pressed={people.includes(me)} title={people.join(", ")} onClick={() => canAct && onReact(emoji)} disabled={!canAct}>
              {emoji} <small>{people.length}</small>
            </button>
          ))}
        </div>
      )}
      <span className="message-time">
        {String(message.at).replace(/ · Demo$/, "")}
        {message.draft && " · Not sent"}
      </span>
      {canAct && (
        <div className="message-actions">
          <button type="button" aria-label="Reply" title="Reply" onClick={() => onReply(index)}>
            <ArrowBendUpLeft size={15} />
          </button>
          <button type="button" aria-label="React" title="React" aria-expanded={reacting} onClick={() => setReacting(!reacting)}>
            <Smiley size={15} />
          </button>
          {reacting && (
            <div className="reaction-bar">
              {REACTIONS.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={"React " + emoji}
                  onClick={() => {
                    onReact(emoji);
                    setReacting(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The line above the composer while answering a message. */
export function ReplyBar({ message, onCancel }) {
  return (
    <div className="reply-bar" role="status">
      <ArrowBendUpLeft size={18} />
      <span>
        <strong>Reply to {message.from}</strong>
        <small>{messagePreview(message)}</small>
      </span>
      <button type="button" aria-label="Cancel reply" onClick={onCancel}>
        <X size={15} />
      </button>
    </div>
  );
}
