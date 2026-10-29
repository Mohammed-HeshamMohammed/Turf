import { useState } from "react";
import { Archive, ArrowUUpLeft, EnvelopeSimple, PaperPlaneTilt, Plus } from "@phosphor-icons/react";
import { useCrm } from "./context.jsx";
import { ROLES } from "./data.js";
import { EmailThread, subjectOf } from "./email.jsx";
import { capability, uid, visibleLeads, visibleThreads } from "./model.js";
import { Badge, Button, Card, Empty, Field, Modal, PageHeader, RoundButton, Search, Select } from "./ui.jsx";

// Mail: email with leads and partners, kept apart from the chats in Inbox. Folders, subject-first rows, and the email
// reader (email.jsx) beside them. What may be sent is checked in model.js like every other message.

const FOLDERS = {
  Inbox: thread => !thread.archived,
  Sent: thread => !thread.archived && thread.messages.some(message => !message.incoming && !message.draft),
  Drafts: thread => Boolean(thread.emailDraft) || thread.messages.some(message => message.draft),
  Archived: thread => Boolean(thread.archived),
};
const EMPTY = {
  Inbox: ["No email yet", "Write to a lead with New email."],
  Sent: ["Nothing sent yet", "Emails you send appear here."],
  Drafts: ["No drafts", "Anything you start writing and leave unsent waits here."],
  Archived: ["Nothing archived", "Archive an email to keep it out of the way without deleting it."],
};

/** A new email to a lead: who, Cc, subject and text. It starts its own thread, as a new subject does in any mail app. */
function NewEmail({ leads, initialLead, onSend, onClose }) {
  const [form, setForm] = useState({ leadId: initialLead || leads[0]?.id || "", cc: "", subject: "", text: "" });
  const lead = leads.find(item => item.id === form.leadId);
  const set = key => event => setForm({ ...form, [key]: event.target.value });
  const ready = Boolean(lead?.email && form.subject.trim() && form.text.trim());
  return (
    <Modal title="New email" onClose={onClose}>
      <form
        className="new-email"
        onSubmit={event => {
          event.preventDefault();
          if (ready) onSend({ lead, cc: form.cc, subject: form.subject, text: form.text });
        }}
      >
        <Field label="To" help={lead?.email || "This lead has no email address."}>
          <Select value={form.leadId} onChange={set("leadId")}>
            {leads.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cc">
          <input value={form.cc} onChange={set("cc")} placeholder="Optional, separate with commas" />
        </Field>
        <Field label="Subject">
          <input value={form.subject} maxLength={200} onChange={set("subject")} placeholder="Your property on Baywood Drive" required />
        </Field>
        <Field label="Message">
          <textarea value={form.text} onChange={set("text")} rows={8} required />
        </Field>
        <button type="submit" className="button primary" disabled={!ready}>
          <PaperPlaneTilt size={16} /> Send email
        </button>
      </form>
    </Modal>
  );
}

export function Mail() {
  const { state, dispatch, navigate, notify, route } = useCrm();
  const [folder, setFolder] = useState("Inbox");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const params = new URLSearchParams(route.split("?")[1]);
  const requestedLead = params.get("lead");
  const leads = visibleLeads(state);
  const me = ROLES[state.role].person;
  const canMessage = capability(state, "message");
  const all = visibleThreads(state).filter(thread => thread.channel === "Email");
  // Opened for a lead with no email yet (the lead page's address link): start a new email to them.
  const [writing, setWriting] = useState(() => (requestedLead && !all.some(thread => thread.leadId === requestedLead) ? requestedLead : null));
  const name = thread => leads.find(item => item.id === thread.leadId)?.name || "Unknown";
  const threads = all.filter(FOLDERS[folder]).filter(thread => {
    const words = [name(thread), subjectOf(thread), ...thread.messages.map(message => message.text)].join(" ").toLowerCase();
    return words.includes(query.trim().toLowerCase());
  });
  const thread =
    threads.find(item => item.id === selected) ||
    threads.find(item => item.id === params.get("thread")) ||
    (requestedLead && threads.find(item => item.leadId === requestedLead)) ||
    threads[0];
  const lead = leads.find(item => item.id === thread?.leadId);
  const count = key => (key === "Inbox" ? all.filter(item => FOLDERS.Inbox(item) && item.unread).length : key === "Drafts" ? all.filter(FOLDERS.Drafts).length : 0);
  const withEmail = leads.filter(item => item.email);
  const startNew = () => setWriting(lead?.id || withEmail[0]?.id || "");
  return (
    <>
      <PageHeader title="Mail" description="Email with leads and partners, kept apart from chats.">
        {canMessage && (
          <Button variant="primary" icon={Plus} onClick={startNew}>
            New email
          </Button>
        )}
      </PageHeader>
      <div className="inbox-layout mail-layout">
        <Card className="thread-list">
          <Search value={query} onChange={setQuery} placeholder="Search mail" />
          <div className="thread-chips" role="group" aria-label="Folders">
            {Object.keys(FOLDERS).map(key => (
              <button
                key={key}
                type="button"
                aria-pressed={folder === key}
                onClick={() => {
                  setFolder(key);
                  setSelected("");
                }}
              >
                {key}
                {count(key) > 0 && <span className="chip-count">{count(key)}</span>}
              </button>
            ))}
          </div>
          <div className="thread-items">
            {threads.map(item => {
              const latest = item.messages.at(-1);
              const shown = folder === "Sent" ? item.messages.filter(message => !message.incoming && !message.draft).at(-1) || latest : latest;
              return (
                <div className="thread-row" key={item.id}>
                  <button
                    type="button"
                    className={"thread mail-row" + (thread?.id === item.id ? " selected" : "") + (item.unread ? " unread" : "")}
                    aria-current={thread?.id === item.id ? "true" : undefined}
                    onClick={() => {
                      setSelected(item.id);
                      dispatch({ type: "MARK_READ", id: item.id });
                    }}
                  >
                    <span className="thread-body">
                      <span className="thread-top">
                        <strong>{folder === "Sent" ? "To: " + name(item) : name(item)}</strong>
                        <time>{shown?.at}</time>
                      </span>
                      <span className="mail-subject">
                        {item.emailDraft && <em>Draft</em>}
                        {subjectOf(item)}
                      </span>
                      <span className="thread-meta">{item.emailDraft?.text?.trim() || shown?.text || "No messages yet"}</span>
                    </span>
                    {item.unread && <span className="unread-dot" aria-label="Unread" />}
                  </button>
                  <button
                    type="button"
                    className="thread-archive"
                    aria-label={(item.archived ? "Unarchive " : "Archive ") + subjectOf(item)}
                    title={item.archived ? "Unarchive" : "Archive"}
                    onClick={() => dispatch({ type: "ARCHIVE", id: item.id, archived: !item.archived })}
                  >
                    {item.archived ? <ArrowUUpLeft size={16} /> : <Archive size={16} />}
                  </button>
                </div>
              );
            })}
            {!threads.length && (query ? <Empty title="Nothing matches">Try another name, subject or word.</Empty> : <Empty title={EMPTY[folder][0]}>{EMPTY[folder][1]}</Empty>)}
          </div>
        </Card>
        <Card className="conversation">
          {thread ? (
            <>
              <header>
                <div>
                  <h2>{lead?.name || "Unknown"}</h2>
                  <small>
                    <Badge>Email</Badge>
                    {lead?.email && <span>{lead.email}</span>}
                    {lead?.address && <span>{lead.address}</span>}
                  </small>
                </div>
                <div className="conversation-actions">
                  <RoundButton
                    icon={thread.archived ? ArrowUUpLeft : Archive}
                    label={thread.archived ? "Unarchive email" : "Archive email"}
                    onClick={() => dispatch({ type: "ARCHIVE", id: thread.id, archived: !thread.archived })}
                  />
                  {lead && <RoundButton label="Open lead" onClick={() => navigate("work/leads/" + lead.id)} />}
                </div>
              </header>
              <EmailThread
                key={thread.id}
                thread={thread}
                lead={lead}
                me={me}
                canMessage={canMessage}
                online={state.online}
                onDraft={draft => dispatch({ type: "EMAIL_DRAFT", id: thread.id, draft })}
                onSend={({ text, email }) => {
                  dispatch({ type: "MESSAGE", id: thread.id, text, email });
                  notify(state.online ? "Demo email added — nothing was sent externally" : "Email draft saved offline");
                }}
              />
            </>
          ) : (
            <Empty title="Choose an email" action={canMessage && <Button onClick={startNew}>New email</Button>}>
              <EnvelopeSimple size={18} /> Pick an email from the list, or write a new one.
            </Empty>
          )}
        </Card>
      </div>
      {writing !== null && canMessage && (
        <NewEmail
          leads={withEmail}
          initialLead={writing}
          onClose={() => setWriting(null)}
          onSend={({ lead: to, cc, subject, text }) => {
            const id = uid();
            dispatch({ type: "NEW_THREAD", thread: { id, leadId: to.id, channel: "Email", subject: subject.trim(), shared: false, preview: subject.trim(), unread: false, messages: [] } });
            dispatch({ type: "MESSAGE", id, text, email: { to: to.email, cc, subject } });
            setFolder("Inbox");
            setSelected(id);
            setWriting(null);
            notify(state.online ? "Demo email added — nothing was sent externally" : "Email draft saved offline");
          }}
        />
      )}
    </>
  );
}
