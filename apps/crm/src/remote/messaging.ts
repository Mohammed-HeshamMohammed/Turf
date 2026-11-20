// Team chats and groups from the messaging service (services/messaging), shaped the way the Inbox already draws conversations.
// The service is the truth: this keeps a copy for the screen, adds what the person sends at once (and marks it "not sent" if
// the server refuses), and catches up by message number. It listens on the live server when there is one, and asks again
// every few seconds either way, so a missed live update is only a short delay.

import { request } from "./api.ts";

const remembered = key => {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
};

/** Where the messaging service is (VITE_CALLERWHALE_MESSAGING_URL). Empty: this build has no team chat on the server. */
export function messagingBase() {
  return (remembered("callerwhale.messaging.url") || import.meta.env?.VITE_CALLERWHALE_MESSAGING_URL || "").replace(/\/$/, "");
}

type Person = { id: string; name: string };
type ServerMessage = {
  id: string; conversation_id: string; seq: number; sender_id: string; kind: string; body: string; reply_to: string | null; mentions: string[];
  created_at: string; edited_at: string | null; deleted: boolean; reactions: { emoji: string; user_id: string }[];
  poll: { question: string; options: string[]; votes: { user_id: string; option: number }[] } | null;
};
type ServerConversation = {
  id: string; kind: string; title: string; last_seq: number; last_read_seq: number; unread: number; archived: boolean; muted: boolean;
  members: { user_id: string; role: string }[]; last_message: ServerMessage | null; last_message_at: string | null;
};

const lower = (id: string) => String(id || "").toLowerCase();

/** "14:05" for today, "Nov 12" for another day. */
export function messageTime(iso: string, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
    : at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** One server message as the Inbox draws it. `all` is the conversation's loaded messages, to find the one a reply answers. */
export function toMessage(message: ServerMessage, all: ServerMessage[], nameOf: (id: string) => string, me: string, now = new Date()) {
  const from = nameOf(message.sender_id);
  const base = { id: message.id, seq: message.seq, from, at: messageTime(message.created_at, now) + (message.edited_at && !message.deleted ? " · edited" : ""), incoming: lower(message.sender_id) !== lower(me) };
  if (message.deleted) return { ...base, kind: "system", text: "Message deleted" };
  if (message.kind === "system") {
    const who = (message.mentions || []).map(nameOf).join(", ");
    const text = message.body === "left" ? `${who} left` : message.body === "removed" ? `${from} removed ${who}` : `${from} added ${who}`;
    return { ...base, kind: "system", incoming: true, text };
  }
  const reactions: Record<string, string[]> = {};
  for (const reaction of message.reactions || []) (reactions[reaction.emoji] ||= []).push(nameOf(reaction.user_id));
  const replyTo = message.reply_to ? all.findIndex(item => item.id === message.reply_to) : -1;
  const out: Record<string, unknown> = { ...base, text: message.kind === "poll" ? "" : message.body, ...(replyTo >= 0 ? { replyTo } : {}), ...(Object.keys(reactions).length ? { reactions } : {}) };
  if (message.kind === "poll" && message.poll) {
    out.kind = "poll";
    out.poll = { question: message.poll.question, options: message.poll.options.map((text, index) => ({ text, votes: message.poll.votes.filter(vote => vote.option === index).map(vote => nameOf(vote.user_id)) })) };
  }
  return out;
}

const previewOf = (message: Record<string, any> | undefined) => (message ? (message.kind === "poll" ? "Poll: " + message.poll.question : message.text) : "");

/** One conversation as an Inbox thread: a group, or a direct chat titled with the other person's name. */
export function toThread(conversation: ServerConversation, messages: ServerMessage[], people: Person[], me: string, now = new Date()) {
  const names = new Map(people.map(person => [lower(person.id), person.name]));
  const nameOf = (id: string) => names.get(lower(id)) || "Former member";
  const members = conversation.members.map(member => nameOf(member.user_id));
  const other = conversation.members.find(member => lower(member.user_id) !== lower(me));
  const shown = messages.map(message => toMessage(message, messages, nameOf, me, now));
  const last = shown.at(-1) || (conversation.last_message ? toMessage(conversation.last_message, [], nameOf, me, now) : undefined);
  return {
    id: conversation.id,
    chat: true, // lives in the messaging service, not in this device's records
    channel: conversation.kind === "group" ? "Group" : "Team",
    title: conversation.kind === "group" ? conversation.title : other ? nameOf(other.user_id) : "Direct chat",
    leadId: null,
    members,
    owner: nameOf(conversation.members.find(member => member.role === "owner")?.user_id || ""),
    shared: false,
    unread: conversation.unread > 0,
    archived: conversation.archived,
    preview: previewOf(last) || (conversation.kind === "group" ? "New group" : "New conversation"),
    messages: shown.length ? shown : last ? [last] : [],
  };
}

/** The teammates named with "@Name" in a message, as ids. */
export function mentionedIds(text: string, people: Person[]) {
  return people.filter(person => person.name && text.includes("@" + person.name)).map(person => person.id);
}

type Options = { base?: string; me: string; people: Person[]; onThreads: (threads: any[]) => void; onError?: (message: string) => void; interval?: number; ask?: typeof request; live?: boolean };

export class Messaging {
  private base: string;
  private me: string;
  private people: Person[];
  private onThreads: Options["onThreads"];
  private onError: (message: string) => void;
  private ask: typeof request;
  private conversations = new Map<string, ServerConversation>();
  private messages = new Map<string, ServerMessage[]>();
  private unsent = new Map<string, any[]>(); // what the person sent that the server has not confirmed, per conversation
  private order: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private interval: number;
  private socket: { disconnect: () => void } | null = null;
  private wantLive: boolean;
  private stopped = false;
  private busy: Promise<void> | null = null;
  private flagged = new Set<string>(); // conversations the person marked unread again, on this device

  constructor({ base = messagingBase(), me, people, onThreads, onError = () => {}, interval = 5000, ask = request, live = true }: Options) {
    Object.assign(this, { base, me, people, onThreads, onError, interval, ask, wantLive: live });
  }

  has(id: string) {
    return this.conversations.has(id);
  }

  private call(method: string, path: string, body?: unknown) {
    return this.ask(method, "/api/v1/messaging" + path, body, { base: this.base });
  }

  async start() {
    await this.refresh();
    if (this.stopped) return;
    this.timer = setInterval(() => void this.refresh().catch(() => {}), this.interval);
    if (this.wantLive) void this.listen().catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.disconnect();
    this.timer = this.socket = null;
  }

  /** Takes the list again and, for each conversation with something new, the messages after the last number held. */
  refresh(): Promise<void> {
    this.busy ||= this.load().finally(() => (this.busy = null));
    return this.busy;
  }

  private async load() {
    const { conversations } = await this.call("GET", "/conversations");
    if (this.stopped) return;
    const seen = new Set<string>();
    for (const conversation of conversations as ServerConversation[]) {
      seen.add(conversation.id);
      this.conversations.set(conversation.id, conversation);
      const held = this.messages.get(conversation.id);
      const lastHeld = held?.at(-1)?.seq || 0;
      if (!held) await this.fetchMessages(conversation.id, "");
      else if (conversation.last_seq > lastHeld) await this.fetchMessages(conversation.id, "?after=" + lastHeld);
    }
    for (const id of [...this.conversations.keys()]) if (!seen.has(id)) (this.conversations.delete(id), this.messages.delete(id), this.unsent.delete(id));
    this.order = (conversations as ServerConversation[]).map(item => item.id);
    this.emit();
  }

  private async fetchMessages(id: string, query: string) {
    const { messages } = await this.call("GET", `/conversations/${id}/messages${query || "?limit=200"}`);
    const held = query ? this.messages.get(id) || [] : [];
    const known = new Set(held.map(item => item.id));
    this.messages.set(id, [...held, ...(messages as ServerMessage[]).filter(item => !known.has(item.id))].sort((a, b) => a.seq - b.seq));
  }

  private emit() {
    if (this.stopped) return;
    const now = new Date();
    this.onThreads(
      this.order.filter(id => this.conversations.has(id)).map(id => {
        const made = toThread(this.conversations.get(id), this.messages.get(id) || [], this.people, this.me, now);
        const thread = this.flagged.has(id) ? { ...made, unread: true } : made;
        const waiting = this.unsent.get(id) || [];
        return waiting.length ? { ...thread, preview: previewOf(waiting.at(-1)), messages: [...thread.messages, ...waiting] } : thread;
      }),
    );
  }

  /** The live server tells this person's channel that something changed; what changed is then read from the service. */
  private async listen() {
    const where = await this.call("GET", "/live");
    if (!where?.enabled || this.stopped) return;
    const { Centrifuge } = await import("centrifuge");
    const socket = new Centrifuge(where.url, { token: where.token, getToken: async () => (await this.call("GET", "/live")).token });
    const subscription = socket.newSubscription(where.channel);
    subscription.on("publication", ({ data }) => this.heard(data));
    // Whatever was missed while the socket was away is picked up by asking again.
    subscription.on("subscribed", () => void this.refresh().catch(() => {}));
    subscription.subscribe();
    socket.connect();
    this.socket = socket;
    if (this.stopped) socket.disconnect();
  }

  private heard(data: any) {
    const held = data?.conversation_id && this.messages.get(data.conversation_id);
    if (data?.type === "message_changed" && held && data.message) {
      this.messages.set(data.conversation_id, held.map(item => (item.id === data.message.id ? data.message : item)));
      this.emit();
      return;
    }
    void this.refresh().catch(() => {});
  }

  private pending(id: string, message: any) {
    this.unsent.set(id, [...(this.unsent.get(id) || []), message]);
    this.order = [id, ...this.order.filter(item => item !== id)];
    this.emit();
  }

  private settle(id: string, messageId: string, failed: boolean) {
    const waiting = this.unsent.get(id) || [];
    this.unsent.set(id, failed ? waiting.map(item => (item.id === messageId ? { ...item, draft: true, at: "Not sent" } : item)) : waiting.filter(item => item.id !== messageId));
  }

  /** Sends text or a poll. It shows at once; the id is made here, so a retry after a lost reply saves it once. */
  async send(id: string, text: string, { replyTo, poll }: { replyTo?: number; poll?: { question: string; options: string[] } } = {}) {
    const held = this.messages.get(id) || [];
    const answered = Number.isInteger(replyTo) ? held[replyTo] : undefined;
    const body = text.trim();
    if (!body && !poll) return;
    const messageId = crypto.randomUUID();
    const options = poll?.options.map(option => option.trim()).filter(Boolean);
    const myName = this.people.find(person => lower(person.id) === lower(this.me))?.name || "You";
    this.pending(id, {
      id: messageId, from: myName, incoming: false, at: "Sending…", text: poll ? "" : body,
      ...(answered ? { replyTo } : {}),
      ...(poll ? { kind: "poll", poll: { question: poll.question.trim(), options: options.map(option => ({ text: option, votes: [] })) } } : {}),
    });
    try {
      const members = new Set((this.conversations.get(id)?.members || []).map(member => lower(member.user_id)));
      await this.call("POST", `/conversations/${id}/messages`, {
        id: messageId, body,
        ...(answered ? { reply_to: answered.id } : {}),
        ...(poll ? { poll: { question: poll.question.trim(), options } } : { mentions: mentionedIds(body, this.people).filter(person => members.has(lower(person))) }),
      });
      this.settle(id, messageId, false);
      await this.refresh();
    } catch (error) {
      this.settle(id, messageId, true);
      this.emit();
      this.onError(error?.message || "The message was not sent.");
    }
  }

  private async change(work: () => Promise<unknown>) {
    try {
      await work();
      await this.refresh();
    } catch (error) {
      this.onError(error?.message || "That could not be saved.");
    }
  }

  /** Adds the person's reaction, or takes it back when they already gave it. */
  react(id: string, index: number, emoji: string) {
    const message = (this.messages.get(id) || [])[index];
    if (!message) return;
    const mine = message.reactions.some(reaction => reaction.emoji === emoji && lower(reaction.user_id) === lower(this.me));
    return this.change(async () => this.replace(id, (await this.call(mine ? "DELETE" : "PUT", `/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`)).message));
  }

  vote(id: string, index: number, option: number) {
    const message = (this.messages.get(id) || [])[index];
    if (!message) return;
    return this.change(async () => this.replace(id, (await this.call("POST", `/messages/${message.id}/vote`, { option })).message));
  }

  private replace(id: string, message: ServerMessage) {
    if (message) this.messages.set(id, (this.messages.get(id) || []).map(item => (item.id === message.id ? message : item)));
    this.emit();
  }

  archive(id: string, archived: boolean) {
    return this.change(() => this.call("PATCH", `/conversations/${id}`, { archived }));
  }

  /** Read up to the newest message. (Marking unread again is this device's own reminder; the service only moves forward.) */
  markRead(id: string) {
    if (this.flagged.delete(id)) this.emit();
    const conversation = this.conversations.get(id);
    if (!conversation || conversation.unread === 0) return;
    return this.change(() => this.call("POST", `/conversations/${id}/read`, { seq: conversation.last_seq }));
  }

  markUnread(id: string) {
    if (!this.conversations.has(id)) return;
    this.flagged.add(id);
    this.emit();
  }

  /** Starts a group, or opens the direct chat with one person (the one that exists, if there is one). Answers its id. */
  async create(kind: "direct" | "group", memberIds: string[], title = ""): Promise<string | null> {
    try {
      const conversation = await this.call("POST", "/conversations", { kind, title, member_ids: memberIds });
      await this.refresh();
      return conversation.id;
    } catch (error) {
      this.onError(error?.message || "The conversation could not be started.");
      return null;
    }
  }
}
