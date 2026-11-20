// What the consent page checks in an assistant's request, kept apart so it can be tested.

export type Asked = { clientId: string; redirectUri: string; scope: string; state: string; challenge: string };

/** The parts of an assistant's request that arrive in the address when it sends someone here (see auth's /v1/connectors/authorize). */
export function askedFrom(search: string): Asked | null {
  const q = new URLSearchParams(search);
  const asked = { clientId: q.get("client_id") ?? "", redirectUri: q.get("redirect_uri") ?? "", scope: q.get("scope") ?? "account:read", state: q.get("state") ?? "", challenge: q.get("code_challenge") ?? "" };
  return asked.clientId && asked.redirectUri && asked.challenge ? asked : null;
}

// Where the well-known assistants send people back. Anyone can register an app and give it any name, so a name like "Claude" proves
// nothing; the return address does. An app that returns anywhere else gets a clear warning before the person allows it.
const KNOWN_HOSTS = ["claude.ai", "claude.com", "anthropic.com", "chatgpt.com", "openai.com", "gemini.google.com"];
export function returnKind(host: string): "known" | "local" | "unknown" {
  const name = host.toLowerCase().replace(/:\d+$/, "");
  if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return "local";
  return KNOWN_HOSTS.some(known => name === known || name.endsWith("." + known)) ? "known" : "unknown";
}

