// The logic of the helper chat that is not drawing: what is sent, what is remembered, and when a suggestion may appear. Kept apart from
// Assistant.tsx so it can be tested.

export type Link = { label: string; to: string };
export type Turn = { role: "user" | "assistant"; content: string; suggestions?: string[]; link?: Link };
export type Reply = { source: "scripted" | "ai"; answer: { reply: string; suggestions?: string[]; link?: Link } };

export const assistantBase = (import.meta.env?.VITE_CALLERWHALE_ASSISTANT_URL || "https://assistant.callerwhale.com").replace(/\/$/, "");

export const MAX_TURNS = 12;
export const MAX_CHARS = 600;
export const FIRST_QUESTION = "Which plan fits me?";

export const greeting: Turn = {
  role: "assistant",
  content: "Hi, I'm the Caller Whale assistant. I'm automated, so I can be wrong: for anything about your account or billing, the team is the right place. How can I help?",
  suggestions: [FIRST_QUESTION, "What does Caller Whale do?", "Is there a free trial?"],
};

/** What is sent to the server: the last turns, text only, never longer than it accepts. */
export function outgoing(turns: Turn[]): { role: string; content: string }[] {
  return turns
    .filter(turn => turn !== greeting && turn.content.trim())
    .slice(-MAX_TURNS)
    .map(turn => ({ role: turn.role, content: turn.content.slice(0, MAX_CHARS) }));
}

/** The reply as a chat turn. Anything the server sends that is not text or a path on this site is dropped. */
export function turnFrom(reply: Reply): Turn {
  const { answer } = reply;
  const link = answer.link && typeof answer.link.to === "string" && answer.link.to.startsWith("/") && !answer.link.to.startsWith("//") ? answer.link : undefined;
  return { role: "assistant", content: String(answer.reply ?? ""), suggestions: (answer.suggestions ?? []).filter(s => typeof s === "string").slice(0, 4), link };
}

/** A suggestion that opens by itself, on the pages where people choose a plan; null elsewhere. `seconds` is how long they have been on it. */
export function nudgeFor(path: string, seconds: number): { text: string; ask: string } | null {
  if (path === "/pricing" && seconds >= 12) return { text: "Not sure which plan fits? Tell me how many people will make calls and I will point you to one.", ask: FIRST_QUESTION };
  if (path === "/" && seconds >= 25) return { text: "Wondering where to start? I can tell you which plan suits you.", ask: FIRST_QUESTION };
  if (path === "/features" && seconds >= 30) return { text: "Want to know which plan has the features you care about?", ask: FIRST_QUESTION };
  return null;
}

const kept = (key: string) => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(key);
  } catch {
    return null;
  }
};
const keep = (key: string, value: string) => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* Not remembered: the hint may show again, nothing breaks. */
  }
};

export const seen = (what: string) => kept("cw-assistant-" + what) === "1";
export const markSeen = (what: string) => keep("cw-assistant-" + what, "1");

export function loadTurns(): Turn[] {
  try {
    const stored = JSON.parse(kept("cw-assistant-turns") || "[]");
    return Array.isArray(stored) ? stored.filter(t => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string").slice(-40) : [];
  } catch {
    return [];
  }
}
export const saveTurns = (turns: Turn[]) => keep("cw-assistant-turns", JSON.stringify(turns.slice(-40)));

export async function ask(turns: Turn[], page: string, signal?: AbortSignal, base = assistantBase, fetcher: typeof fetch = fetch): Promise<Turn> {
  const response = await fetcher(`${base}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: outgoing(turns), page }),
    signal,
  });
  if (response.status === 429) throw new Error("That is a lot of messages at once. Give me a moment, then try again.");
  if (!response.ok) throw new Error("The assistant is not available right now.");
  return turnFrom((await response.json()) as Reply);
}
